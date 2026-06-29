// Google Calendar + Meet integration (Calendly-style).
//
// Flow:
//   1. /api/calendar/google/connect  → returns a Google consent URL (state = signed JWT of the user).
//   2. Google redirects to /api/public/google/callback (PUBLIC) with ?code&state.
//   3. We exchange the code for tokens and store them on a GoogleAccount.
//   4. On a public booking, createMeetEvent() inserts an event on the host's
//      calendar WITH a Meet link and the attendee invited (sendUpdates:"all"),
//      so Google adds it to both calendars and emails the invite.
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (backend only — never the frontend),
//      optional GOOGLE_REDIRECT_URI (else derived from PUBLIC_API_BASE),
//      PUBLIC_API_BASE, CLIENT_URL, JWT_SECRET.

const { google } = require("googleapis");
const jwt = require("jsonwebtoken");
const GoogleAccount = require("../models/GoogleAccount");

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

// calendar.events is enough to create events AND attach a Meet link via
// conferenceData. userinfo.email lets us show which account is connected.
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
];

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri() {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const apiBase = (process.env.PUBLIC_API_BASE || "http://localhost:8080").replace(/\/$/, "");
  return `${apiBase}/api/public/google/callback`;
}

// Accept a client-supplied redirect URI (derived from the frontend's
// VITE_API_URL) only if it's a well-formed http(s) URL pointing at OUR own
// callback path. This lets a single env var (VITE_API_URL) move the whole
// OAuth flow between local and production. Anything else → null, and we fall
// back to the server default. Google still enforces that the final URI is one
// registered in the Cloud Console, so this can't be abused as an open redirect.
function sanitizeRedirectUri(uri) {
  if (!uri) return null;
  try {
    const u = new URL(String(uri));
    if (!/^https?:$/.test(u.protocol)) return null;
    if (u.pathname.replace(/\/$/, "") !== "/api/public/google/callback") return null;
    return u.origin + u.pathname.replace(/\/$/, "");
  } catch { return null; }
}

function oauthClient(redirectOverride) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectOverride || redirectUri(),
  );
}

// `redirect` is stashed in the signed state so the callback exchanges the code
// against the EXACT same redirect_uri used at the authorize step (Google
// requires them to match).
function makeState(userId, orgId, redirect) {
  return jwt.sign(
    { uid: String(userId), org: orgId ? String(orgId) : null, r: redirect || null },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}
function readState(state) {
  try { return jwt.verify(state, JWT_SECRET); } catch { return null; }
}

function authUrl(state, redirectOverride) {
  return oauthClient(redirectOverride).generateAuthUrl({
    access_type: "offline",   // needed to get a refresh token
    prompt: "consent",        // force refresh_token on every connect
    include_granted_scopes: true,
    scope: SCOPES,
    state,
  });
}

async function exchangeCode(code, redirectOverride) {
  const client = oauthClient(redirectOverride);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  let email = "";
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const me = await oauth2.userinfo.get();
    email = me.data?.email || "";
  } catch { /* email is best-effort */ }
  return { tokens, email };
}

// Build an authed client from a stored account and persist any refreshed tokens.
function clientForAccount(account) {
  const client = oauthClient();
  client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.expiryDate ? new Date(account.expiryDate).getTime() : undefined,
  });
  client.on("tokens", (t) => {
    const patch = {};
    if (t.access_token) patch.accessToken = t.access_token;
    if (t.refresh_token) patch.refreshToken = t.refresh_token;
    if (t.expiry_date) patch.expiryDate = new Date(t.expiry_date);
    if (Object.keys(patch).length) {
      GoogleAccount.updateOne({ _id: account._id }, { $set: patch }).catch(() => {});
    }
  });
  return client;
}

// Google connection is per (user, organization). Pass the org so each workspace
// uses its OWN connected Google account.
function getAccountForUser(userId, orgId = null) {
  return GoogleAccount.findOne({ user: userId, organization: orgId || null })
    .select("+accessToken +refreshToken");
}

// Create a calendar event with a Google Meet link and invite the attendee.
// Returns { id, htmlLink, meetLink }.
async function createMeetEvent(account, { summary, description, startISO, endISO, timeZone, attendees = [] }) {
  const auth = clientForAccount(account);
  const calendar = google.calendar({ version: "v3", auth });
  const requestId = `ldn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const res = await calendar.events.insert({
    calendarId: account.calendarId || "primary",
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone },
      end:   { dateTime: endISO, timeZone },
      attendees: attendees.filter(Boolean).map((e) => ({ email: e })),
      conferenceData: {
        createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
      reminders: { useDefault: true },
    },
  });

  const ev = res.data || {};
  const meetLink =
    ev.hangoutLink ||
    ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ||
    "";
  return { id: ev.id, htmlLink: ev.htmlLink, meetLink };
}

module.exports = {
  isConfigured,
  redirectUri,
  sanitizeRedirectUri,
  SCOPES,
  authUrl,
  makeState,
  readState,
  exchangeCode,
  clientForAccount,
  getAccountForUser,
  createMeetEvent,
};
