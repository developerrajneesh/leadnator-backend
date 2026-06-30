/**
 * Subscribe every already-connected Instagram account in the DB to THIS app's
 * webhooks (comments + messages), so events start flowing to /webhooks/instagram
 * without each user having to reconnect.
 *
 * Run: cd backend && node scripts/subscribe-all-instagram.js
 *      (or: npm run ig:subscribe-all)
 */
require("dotenv").config();
const axios = require("axios");
const connectDB = require("../config/db");
const InstagramConnection = require("../models/InstagramConnection");

const API_VERSION = process.env.META_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;
const IG_GRAPH_BASE = `https://graph.instagram.com/${API_VERSION}`;
const SUBSCRIBED_FIELDS = "comments,messages";

function onIgHost(conn) {
  return conn.authMethod === "oauth" || !conn.pageId;
}

async function subscribeOne(conn) {
  const ig = onIgHost(conn);
  const url = ig
    ? `${IG_GRAPH_BASE}/${conn.igAccountId}/subscribed_apps`
    : `${FB_GRAPH_BASE}/${conn.pageId}/subscribed_apps`;
  const token = conn.pageAccessToken;
  if (!token || (!ig && !conn.pageId) || (ig && !conn.igAccountId)) {
    return { ok: false, reason: "missing token/account" };
  }

  const res = await axios({
    method: "post",
    url,
    params: { subscribed_fields: SUBSCRIBED_FIELDS, access_token: token },
    validateStatus: () => true,
  });
  if (res.status >= 200 && res.status < 300) return { ok: true, host: ig ? "ig" : "fb", data: res.data };
  const err = res.data?.error || { message: res.statusText };
  return { ok: false, host: ig ? "ig" : "fb", reason: err.error_user_msg || err.message };
}

async function main() {
  await connectDB();

  const conns = await InstagramConnection.find()
    .select("+pageAccessToken username igAccountId pageId authMethod user organization")
    .lean();

  const summary = { total: conns.length, subscribed: 0, failed: 0, skipped: 0, results: [] };
  console.log(`Found ${conns.length} Instagram connection(s).`);

  for (const conn of conns) {
    const label = `@${conn.username || conn.igAccountId} (${onIgHost(conn) ? "ig-login" : "fb-page"})`;
    try {
      const r = await subscribeOne(conn);
      if (r.ok) {
        summary.subscribed += 1;
        console.log(`✅ ${label} — subscribed`);
      } else if (r.reason === "missing token/account") {
        summary.skipped += 1;
        console.log(`⏭️  ${label} — skipped (${r.reason})`);
      } else {
        summary.failed += 1;
        console.log(`❌ ${label} — ${r.reason}`);
      }
      summary.results.push({ account: conn.username || conn.igAccountId, ...r });
    } catch (e) {
      summary.failed += 1;
      console.log(`❌ ${label} — ${e.message}`);
      summary.results.push({ account: conn.username || conn.igAccountId, ok: false, reason: e.message });
    }
    await new Promise((r) => setTimeout(r, 300)); // gentle pacing
  }

  console.log("\nSummary:", JSON.stringify({ total: summary.total, subscribed: summary.subscribed, failed: summary.failed, skipped: summary.skipped }, null, 2));
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
