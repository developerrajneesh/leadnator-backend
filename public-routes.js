// Public routes — no auth required. Used by /book/:id and /form/:id pages.

const express = require("express");
const BookingType  = require("./models/BookingType");
const Availability = require("./models/Availability");
const Booking      = require("./models/Booking");
const CalendarEvent = require("./models/CalendarEvent");
const Plan         = require("./models/Plan");
const User         = require("./models/User");
const GoogleAccount = require("./models/GoogleAccount");
const EmailCampaign = require("./models/EmailCampaign");
const EmailConfig   = require("./models/EmailConfig");
const EmailMessage  = require("./models/EmailMessage");
const Form          = require("./models/Form");
const Autopilot     = require("./models/Autopilot");
const { runAutopilot } = require("./services/autopilotRunner");
const { parseEmail } = require("./services/mimeParse");
const { emitToUser } = require("./services/socket");
const googleSvc    = require("./services/google");

const router = express.Router();

// ---------- Email open tracking ----------
// 1x1 transparent GIF served on every campaign email open. The pixel URL is
// embedded per-recipient at send time. We count the FIRST open per recipient
// as a unique open and bump campaign.opens. Always returns the pixel, even on
// error, so the email never shows a broken image.
const TRACK_PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

router.get("/email/open", async (req, res) => {
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  try {
    const campaignId = String(req.query.c || "");
    let email = "";
    try { email = Buffer.from(String(req.query.r || ""), "base64url").toString("utf8").toLowerCase(); } catch {}
    if (/^[a-f0-9]{24}$/i.test(campaignId) && email) {
      const camp = await EmailCampaign.findById(campaignId);
      if (camp) {
        const entry = (camp.log || []).find((l) => (l.email || "").toLowerCase() === email);
        if (entry && !entry.openedAt) {
          entry.openedAt = new Date();
          camp.opens = (camp.opens || 0) + 1;
          await camp.save();
        }
      }
    }
  } catch (err) {
    console.warn(`[email open track] ${err.message}`);
  }
  res.end(TRACK_PIXEL);
});

// ---------- Inbound email webhook ----------
// SES receipt rule (via Lambda/SNS) POSTs the raw MIME email here as
// { rawEmail: "<raw>" } (or raw text). We parse it, find which user owns the
// recipient address, and save it as an inbound message in their mailbox.
// Always 200 so SES/Lambda doesn't retry on our parsing hiccups.
function domainOf(addr = "") {
  return String(addr).split("@")[1] || "";
}

router.post("/email/inbound", async (req, res) => {
  try {
    const raw =
      (req.body && (req.body.rawEmail || req.body.content || req.body.email)) ||
      (typeof req.body === "string" ? req.body : "");
    if (!raw || raw.length < 10) return res.status(200).json({ ok: false, reason: "no rawEmail" });

    const mail = parseEmail(raw);
    const recipients = [...(mail.to || []), ...(mail.cc || [])];
    if (!recipients.length) return res.status(200).json({ ok: false, reason: "no recipients" });

    // Only accept mail addressed to a sender profile the user actually created.
    // Mail to any other address on the domain is ignored (not saved).
    let cfg = null;
    let mailbox = "";
    for (const addr of recipients) {
      cfg = await EmailConfig.findOne({ "senders.email": addr });
      if (cfg) { mailbox = addr; break; }
    }
    if (!cfg) {
      console.warn(`[inbound] ignored — no sender profile for ${recipients.join(", ")}`);
      return res.status(200).json({ ok: false, reason: "no matching sender profile" });
    }

    // De-dupe by Message-ID (SES can deliver twice).
    if (mail.messageId) {
      const dup = await EmailMessage.findOne({ user: cfg.user, messageId: mail.messageId, direction: "inbound" });
      if (dup) return res.status(200).json({ ok: true, duplicate: true });
    }

    const msg = await EmailMessage.create({
      user: cfg.user,
      organization: cfg.organization || null,
      direction: "inbound",
      mailbox,
      counterparty: mail.from || "",
      fromName: mail.fromName || "",
      fromEmail: mail.from || "",
      toEmails: recipients,
      subject: mail.subject || "(no subject)",
      text: (mail.text || "").trim(),
      html: mail.html || "",
      messageId: mail.messageId || "",
      inReplyTo: mail.inReplyTo || "",
      read: false,
      ts: mail.date && !isNaN(mail.date) ? mail.date : new Date(),
    });

    console.log(`[inbound] saved mail from ${mail.from} → ${mailbox} (user ${cfg.user})`);
    emitToUser(cfg.user, "email.inbound", { message: msg.toJSON() });
    res.status(200).json({ ok: true, id: msg.id });
  } catch (err) {
    console.error("[inbound] failed:", err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
});

// Best-effort branded confirmation email via Amazon SES (same mailer the
// password-reset flow uses). Silent no-op when SES isn't configured.
const { sendSystemMail } = require("./services/mailer");
async function sendMail(to, subject, html) {
  if (!to) return;
  try {
    await sendSystemMail({ to, subject, html });
  } catch (err) {
    console.warn(`[booking email] failed: ${err.message}`);
  }
}

function fmtWhen(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full", timeStyle: "short", timeZone: timeZone || "Asia/Kolkata",
    }).format(date);
  } catch { return date.toUTCString(); }
}

// Mirror of pricing-routes' DURATIONS — public-facing /pricing page fetches
// the same shape so the marketing and dashboard stay in lock-step.
const DURATIONS = [
  { id: "monthly",  label: "Monthly",  discount: 0,    multiplier: 1,  months: 1  },
  { id: "quarter",  label: "3 Months", discount: 0.05, multiplier: 3,  months: 3  },
  { id: "half",     label: "6 Months", discount: 0.10, multiplier: 6,  months: 6  },
  { id: "yearly",   label: "Yearly",   discount: 0.15, multiplier: 12, months: 12, bestValue: true },
];

// GET /api/public/plans — same payload as /api/pricing/plans but public,
// so the marketing landing page can show live plan data.
router.get("/plans", async (_req, res, next) => {
  try {
    const plans = await Plan.find().sort({ price: 1 });
    res.json({ plans, durations: DURATIONS });
  } catch (err) { next(err); }
});

// ---------- GOOGLE OAUTH CALLBACK (public — Google redirects here) ----------
router.get("/google/callback", async (req, res) => {
  // Redirect back to the APP (prefer APP_URL, then CLIENT_URL). The Month/Week
  // calendar views read ?google=… and show the connected/synced state + toast.
  const clientUrl = (process.env.APP_URL || process.env.CLIENT_URL || "http://localhost:5173").replace(/\/$/, "");
  const back = (q) => res.redirect(`${clientUrl}/calendar/month?${q}`);
  try {
    const { code, state, error } = req.query;
    if (error) return back(`google=error&msg=${encodeURIComponent(String(error))}`);
    if (!code || !state) return back("google=error&msg=Missing+code");

    const decoded = googleSvc.readState(String(state));
    if (!decoded?.uid) return back("google=error&msg=Invalid+state");

    // The state token can go stale (e.g. the account/workspace was recreated),
    // pointing at IDs that no longer exist. Resolve the REAL current user + a
    // valid org membership so the connection is stored where status reads it.
    const OrgMembership = require("./models/OrgMembership");
    const user = await User.findById(decoded.uid).select("_id");
    if (!user) return back("google=error&msg=Please+log+in+again+and+retry");

    let orgId = null;
    if (decoded.org) {
      const m = await OrgMembership.findOne({ user: user._id, organization: decoded.org });
      if (m) orgId = m.organization;
    }
    if (!orgId) {
      // Fall back to the user's primary (earliest) workspace.
      const m = await OrgMembership.findOne({ user: user._id }).sort({ createdAt: 1 });
      orgId = m?.organization || null;
    }

    const { tokens, email } = await googleSvc.exchangeCode(String(code));
    const set = {
      user: user._id,
      organization: orgId,
      email,
      accessToken: tokens.access_token || "",
      scope: tokens.scope || "",
      tokenType: tokens.token_type || "Bearer",
    };
    if (tokens.refresh_token) set.refreshToken = tokens.refresh_token; // only returned on first consent
    if (tokens.expiry_date) set.expiryDate = new Date(tokens.expiry_date);

    await GoogleAccount.findOneAndUpdate(
      { user: user._id, organization: orgId },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return back("google=connected");
  } catch (err) {
    console.error("[google callback]", err.message);
    return back(`google=error&msg=${encodeURIComponent(err.message || "Connection failed")}`);
  }
});

// GET booking type + the host's availability + already-booked slots for that type.
router.get("/booking/:bookingTypeId", async (req, res, next) => {
  try {
    const bt = await BookingType.findById(req.params.bookingTypeId);
    if (!bt) return res.status(404).json({ error: "Booking link not found" });

    const [avail, taken] = await Promise.all([
      Availability.findOne({ user: bt.user, organization: bt.organization || null }),
      Booking.find({ bookingType: bt._id, status: "confirmed" }).select("slot"),
    ]);

    res.json({
      bookingType: bt.toJSON(),
      hostId: bt.user.toString(),
      availability: avail ? avail.toJSON() : null,
      bookedSlots: taken.map((b) => new Date(b.slot).toISOString()),
    });
  } catch (err) { next(err); }
});

// POST a booking from the public page.
router.post("/booking/:bookingTypeId", async (req, res, next) => {
  try {
    const { slot, name, email, phone = "", notes = "" } = req.body || {};
    if (!slot || !name || !email) {
      return res.status(400).json({ error: "slot, name, and email are required" });
    }
    const bt = await BookingType.findById(req.params.bookingTypeId);
    if (!bt) return res.status(404).json({ error: "Booking link not found" });

    const slotDate = new Date(slot);
    if (Number.isNaN(slotDate.getTime())) return res.status(400).json({ error: "Invalid slot" });
    if (slotDate < new Date()) return res.status(400).json({ error: "Slot is in the past" });

    let booking;
    try {
      booking = await Booking.create({
        bookingType: bt._id,
        host: bt.user,
        organization: bt.organization || null,
        slot: slotDate,
        duration: bt.duration,
        name, email, phone, notes,
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: "That slot was just taken — please pick another." });
      }
      throw err;
    }

    const endDate = new Date(slotDate.getTime() + bt.duration * 60000);

    // Mirror the booking into the host's calendar so it shows up in Month/Week/Agenda.
    const calEvent = await CalendarEvent.create({
      user: bt.user,
      organization: bt.organization || null,
      type: "meeting",
      title: `${bt.name} — ${name}`,
      start: slotDate,
      end: endDate,
      attendees: [email],
      location: bt.location,
      notes: notes ? `${notes}\n\n— Booked via public link by ${name} (${email}${phone ? ", " + phone : ""})` : `Booked via public link by ${name} (${email})`,
    });

    // If the host connected Google, create a Calendar event WITH a Meet link and
    // invite the attendee — Google then adds it to both calendars + emails them.
    let meetLink = "";
    try {
      const account = await googleSvc.getAccountForUser(bt.user, bt.organization || null);
      if (account && account.refreshToken) {
        const avail = await Availability.findOne({ user: bt.user, organization: bt.organization || null });
        const tz = avail?.timezone || "Asia/Kolkata";
        const host = await User.findById(bt.user).select("name email");
        const ev = await googleSvc.createMeetEvent(account, {
          summary: `${bt.name} — ${name}`,
          description: [bt.description, notes && `Notes: ${notes}`, `Booked by ${name} (${email}${phone ? ", " + phone : ""})`]
            .filter(Boolean).join("\n\n"),
          startISO: slotDate.toISOString(),
          endISO: endDate.toISOString(),
          timeZone: tz,
          attendees: [email, host?.email].filter(Boolean),
        });
        meetLink = ev.meetLink || "";
        booking.meetLink = meetLink;
        booking.googleEventId = ev.id || "";
        await booking.save();
        await CalendarEvent.updateOne({ _id: calEvent._id }, { $set: { meetLink, googleEventId: ev.id || "", location: meetLink || calEvent.location } });
      }
    } catch (err) {
      console.warn(`[booking] Google event creation failed: ${err.message}`);
    }

    // Branded confirmation email (best-effort). Google also sends its own invite.
    const avail = await Availability.findOne({ user: bt.user, organization: bt.organization || null });
    const whenStr = fmtWhen(slotDate, avail?.timezone);
    const hostUser = await User.findById(bt.user).select("name").lean().catch(() => null);
    const { sendSystemEmail } = require("./services/systemEmail");
    await sendSystemEmail("booking_confirmed", {
      to: email,
      context: {
        user: { name, email },
        booking: { title: bt.name, when: whenStr, host: hostUser?.name || "your host", meetLink: meetLink || "" },
      },
    });

    res.status(201).json({ booking, bookingType: bt.toJSON(), meetLink });
  } catch (err) { next(err); }
});

// ---------- Public form (view + submit) ----------
// Used by the /form/:formId page and iframe embeds. No auth — anyone can fill it.
router.get("/form/:formId", async (req, res, next) => {
  try {
    const form = await Form.findOne({ formId: req.params.formId });
    if (!form) return res.status(404).json({ error: "Form not found" });
    res.json({
      form: {
        formId: form.formId,
        title: form.title,
        description: form.description,
        submitLabel: form.submitLabel,
        style: form.style || {},
        fields: form.fields,
      },
    });
  } catch (err) { next(err); }
});

// Build a friendly, automation-ready payload from raw {fieldId: value} answers:
// label-slug keys plus auto-detected email / phone / name so downstream actions
// (send email, create contact) work without manual field mapping.
function buildSubmissionPayload(form, values) {
  const payload = { _formId: form.formId, _formTitle: form.title };
  for (const f of form.fields || []) {
    const val = values[f.id];
    const slug = String(f.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || f.id;
    payload[slug] = val;
    if (f.type === "email" && val && !payload.email) payload.email = val;
    if (f.type === "phone" && val && !payload.phone) payload.phone = val;
    if (f.type === "text" && /name/i.test(f.label || "") && val && !payload.name) payload.name = val;
  }
  return payload;
}

// Fire any active "Form submitted" autopilots owned by the form's user/org,
// matching either this specific form or "Any form" (blank formId).
async function triggerFormAutopilots(form, values) {
  const or = [];
  if (form.organization) or.push({ organization: form.organization });
  if (form.user) or.push({ createdBy: form.user });
  if (!or.length) return;

  const aps = await Autopilot.find({ status: "active", $or: or });
  const body = buildSubmissionPayload(form, values);

  for (const ap of aps) {
    const trig = ap.config?.trigger;
    if (!trig || trig.type !== "trigger.form_submitted") continue;
    const wantFormId = trig.config?.formId;
    if (wantFormId && wantFormId !== form.formId) continue;

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = { runId, ts: new Date(), method: "FORM", headers: {}, query: {}, body, steps: [] };
    ap.calls = [entry, ...(ap.calls || [])].slice(0, 50);
    ap.callCount = (ap.callCount || 0) + 1;
    ap.lastCalledAt = entry.ts;
    await ap.save();

    const persist = async (steps) => {
      try { await Autopilot.updateOne({ _id: ap._id, "calls.runId": runId }, { $set: { "calls.$.steps": steps } }); } catch {}
    };
    try {
      const result = await runAutopilot(ap, { body }, persist);
      await persist(result.steps);
      console.log(`[form→autopilot] ${ap._id} ran for form ${form.formId} — ${result.steps.length} node(s)`);
    } catch (e) {
      console.warn(`[form→autopilot] run failed for ${ap._id}: ${e.message}`);
    }
  }
}

router.post("/form/:formId/submit", async (req, res, next) => {
  try {
    const { values } = req.body || {};
    if (!values || typeof values !== "object") {
      return res.status(400).json({ error: "values required" });
    }
    const form = await Form.findOne({ formId: req.params.formId });
    if (!form) return res.status(404).json({ error: "Form not found" });

    form.submissions.push({ values, at: new Date() });
    await form.save();

    try { emitToUser(form.user, "form.submission", { formId: form.formId, title: form.title, values }); } catch {}
    res.status(201).json({ ok: true });

    // Fire matching autopilots after responding (don't block the submitter).
    triggerFormAutopilots(form, values).catch((e) => console.warn("[form→autopilot]", e.message));
  } catch (err) { next(err); }
});

module.exports = router;
