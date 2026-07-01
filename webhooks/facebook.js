// Facebook Lead Ads webhook.
//
//   GET  /webhooks/facebook   — Meta verification handshake (mode=subscribe).
//   POST /webhooks/facebook   — receives leadgen events, fetches the lead,
//                               and inserts it into the Lead collection scoped
//                               to whichever user owns the Page.
//
// Multi-tenant: Meta posts a single webhook URL globally. We discriminate by
// `change.value.page_id`; whichever User document has that page in `meta.pages`
// receives the lead.

const express = require("express");
const axios = require("axios");

const User = require("../models/User");
const Lead = require("../models/Lead");
const LeadSettings = require("../models/LeadSettings");

const FB_API_VERSION = process.env.META_API_VERSION || "v23.0";
const FB_GRAPH_BASE  = `https://graph.facebook.com/${FB_API_VERSION}`;
const VERBOSE        = process.env.FB_WEBHOOK_SILENT !== "1";

const router = express.Router();
router.use(express.json({ limit: "2mb" }));

// Ring buffer of recent payloads — reachable at GET /webhooks/facebook/debug.
const RECENT = [];
const MAX_RECENT = 30;
function remember(entry) {
  RECENT.unshift({ ts: new Date().toISOString(), ...entry });
  if (RECENT.length > MAX_RECENT) RECENT.length = MAX_RECENT;
}
function log(...args) { if (VERBOSE) console.log("[webhook/facebook]", ...args); }

// ---------- GET: verify handshake ----------
router.get("/", async (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  log(`GET verify: mode=${mode} token=${token ? token.slice(0, 4) + "…" : "(none)"}`);

  if (mode !== "subscribe" || !token) return res.sendStatus(400);

  // Accept the app-level global verify token (admin configures one webhook in the
  // Meta App Dashboard for the whole platform) OR any individual user's saved token.
  try {
    const globalToken = String(process.env.WEBHOOK_VERIFY_TOKEN || "").trim();
    if (globalToken && token === globalToken) {
      log("→ 200: verified with WEBHOOK_VERIFY_TOKEN from .env");
      return res.status(200).send(challenge);
    }
    const user = await User.findOne({ "meta.webhookVerifyToken": token }).select("+meta.webhookVerifyToken");
    if (user) {
      log(`→ 200: verified for user ${user._id}`);
      return res.status(200).send(challenge);
    }
    log("→ 403: no matching verify token");
  } catch (err) {
    log("→ 500 verify lookup failed:", err.message);
  }
  return res.sendStatus(403);
});

router.get("/debug", (_req, res) => res.json({ count: RECENT.length, recent: RECENT }));

// ---------- POST: leadgen events ----------
router.post("/", async (req, res) => {
  res.sendStatus(200); // ACK fast — Meta retries aggressively.

  log(`POST event @ ${new Date().toISOString()}`);
  if (VERBOSE) console.log(JSON.stringify(req.body, null, 2));

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || entry.messaging || [];
      for (const change of changes) {
        if (change.field !== "leadgen") {
          log(`⚠ skipping non-leadgen field: ${change.field}`);
          continue;
        }
        const value = change.value || {};
        const { leadgen_id, page_id, form_id, created_time } = value;
        if (!leadgen_id || !page_id) {
          log("⚠ missing leadgen_id or page_id"); continue;
        }

        // Find the user who owns this Page — fast path first.
        let user = await User.findOne({ "meta.pages.id": page_id })
          .select("+meta.accessToken +meta.pages.accessToken");

        // Fallback: the user never ran "Sync pages" but Meta is already sending
        // events (common when they subscribed the Page via Meta App Dashboard
        // directly). Walk every Meta-connected user, ask Meta which pages their
        // token can see, and auto-register this page on the first match.
        if (!user) {
          log(`↺ no user has page ${page_id} registered — trying auto-discovery`);
          const candidates = await User.find({ "meta.accessToken": { $exists: true, $ne: "" } })
            .select("+meta.accessToken +meta.pages.accessToken");
          for (const cand of candidates) {
            try {
              const r = await axios.get(`${FB_GRAPH_BASE}/me/accounts`, {
                params: { access_token: cand.meta.accessToken, fields: "id,name,access_token", limit: 200 },
                validateStatus: () => true,
              });
              if (r.status < 200 || r.status >= 300) continue;
              const found = (r.data?.data || []).find((p) => p.id === page_id);
              if (!found) continue;

              // Add the page to this user's meta.pages so future events match instantly.
              cand.meta = cand.meta || {};
              cand.meta.pages = cand.meta.pages || [];
              cand.meta.pages.push({
                id: found.id, name: found.name,
                accessToken: found.access_token,
                subscribed: true, subscribedAt: new Date(),
              });
              await cand.save();
              log(`✓ auto-registered page ${page_id} (${found.name}) to user ${cand._id}`);
              user = cand;
              break;
            } catch (err) { log("auto-discovery error:", err.message); }
          }
        }

        if (!user) {
          log(`⚠ could not find any user whose Meta token can see page ${page_id}`);
          remember({ kind: "ignored", reason: "no user for page (auto-discovery failed)", page_id, leadgen_id });
          continue;
        }
        const page = user.meta.pages.find((p) => p.id === page_id);
        const tokenToUse = page?.accessToken || user.meta?.accessToken;
        if (!tokenToUse) { log(`⚠ no access token to fetch lead ${leadgen_id}`); continue; }

        // Pull the full lead record from Meta.
        let lead;
        try {
          lead = await axios.get(`${FB_GRAPH_BASE}/${leadgen_id}`, {
            params: {
              access_token: tokenToUse,
              fields: "id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,form_id,is_organic",
            },
            validateStatus: () => true,
          });
        } catch (err) { log("✗ fetch lead failed:", err.message); continue; }

        if (lead.status < 200 || lead.status >= 300) {
          log(`✗ Meta returned ${lead.status}:`, lead.data?.error?.message);
          remember({ kind: "fetch_failed", leadgen_id, error: lead.data?.error });
          continue;
        }

        const fields = lead.data?.field_data || [];
        const get = (...keys) => {
          for (const k of keys) {
            const f = fields.find((x) => String(x.name).toLowerCase() === k);
            if (f && f.values?.[0]) return f.values[0];
          }
          return "";
        };

        const fullName  = get("full_name", "name");
        const firstName = get("first_name");
        const lastName  = get("last_name");
        const name      = fullName || [firstName, lastName].filter(Boolean).join(" ").trim() || "(no name)";
        const email     = get("email", "work_email");
        const phone     = get("phone_number", "phone", "work_phone_number");
        const company   = get("company_name");

        // Respect the user's Lead Settings — if they've disabled Meta-form
        // ingestion we still ACK (Meta keeps retrying otherwise) but we
        // don't insert the lead.
        const settings = await LeadSettings.forUser(user._id);
        if (!settings?.metaForms?.enabled) {
          log(`⏸ meta-form ingest disabled for user ${user._id} — skipping leadgen_id ${leadgen_id}`);
          remember({ kind: "disabled_by_settings", source: "meta", leadgen_id, user: user._id.toString() });
          continue;
        }

        // Avoid duplicates if Meta retries.
        const dup = await Lead.findOne({ owner: user._id, "metaLead.leadgenId": leadgen_id });
        if (dup) { log(`↺ dup leadgen_id ${leadgen_id} — skipping`); continue; }

        const notes = fields
          .filter((f) => !["email","work_email","phone_number","phone","work_phone_number","full_name","first_name","last_name","company_name","name"].includes(String(f.name).toLowerCase()))
          .map((f) => `${f.name}: ${(f.values || []).join(", ")}`)
          .join("\n");

        const tagSet = Array.from(new Set(["meta-lead", ...(settings.metaForms.defaultTags || [])]));
        const leadDoc = await Lead.create({
          owner: user._id,
          name, email, phone,
          source: lead.data?.ad_name ? `Meta Ads — ${lead.data.ad_name}` : "Meta Lead Ad",
          status: settings.metaForms.defaultStatus || "new",
          tags: tagSet,
          notes,
          value: settings.metaForms.defaultValue || 0,
          metaLead: {
            leadgenId: leadgen_id,
            formId:    form_id,
            adId:      lead.data?.ad_id,
            adName:    lead.data?.ad_name,
            campaignId:   lead.data?.campaign_id,
            campaignName: lead.data?.campaign_name,
            isOrganic: !!lead.data?.is_organic,
            company,
            rawFieldData: fields,
            createdTime: created_time ? new Date(Number(created_time) * 1000) : new Date(),
          },
        });
        await require("../services/leadAssignment").autoAssignLead(leadDoc);
        log(`✓ created lead ${leadDoc._id} for user ${user._id} (${name})`);
        remember({ kind: "lead", leadgen_id, page_id, name, email, phone });

        // Try to fire the user's `trigger.new_lead` automation flows.
        try {
          const flowRunner = require("../services/flowRunner");
          flowRunner.runTrigger("trigger.new_lead", { user, lead: leadDoc }).catch(() => {});
        } catch { /* flowRunner optional */ }
      }
    }
  } catch (err) {
    log("✗ handler error:", err.message, err.stack);
    remember({ kind: "error", error: err.message });
  }
});

module.exports = router;
