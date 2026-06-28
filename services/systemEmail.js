// High-level system-email sender: looks up the (admin-editable) template for an
// event key, renders {{variables}} from the context, and sends via the mailer
// (Resend → SES fallback). Fire-and-forget friendly — never throws to callers.

const SystemEmailTemplate = require("../models/SystemEmailTemplate");
const { SYSTEM_EMAILS, renderTemplate, defaultByKey } = require("../config/systemEmails");
const { sendSystemMail } = require("./mailer");

// Base URL used in email links/buttons. Prefer a dedicated APP_URL (so email
// links don't depend on CLIENT_URL, which is also used for OAuth redirects).
function appUrl() {
  return String(process.env.APP_URL || process.env.CLIENT_URL || "http://localhost:5173")
    .trim()
    .replace(/\/$/, "");
}

// Resolve the effective template for a key: DB override if present, else default.
async function resolveTemplate(key) {
  const row = await SystemEmailTemplate.findOne({ key }).lean().catch(() => null);
  if (row) return row;
  return defaultByKey(key);
}

/**
 * Send a system email for an event.
 *   sendSystemEmail("account_created", { to, context: { user, trialDays } })
 * Always injects { appUrl } into the context.
 */
async function sendSystemEmail(key, { to, context = {} } = {}) {
  try {
    if (!to) return { ok: false, skipped: true, reason: "no recipient" };
    const tpl = await resolveTemplate(key);
    if (!tpl) return { ok: false, skipped: true, reason: `unknown template ${key}` };
    if (tpl.enabled === false) return { ok: false, skipped: true, reason: "disabled" };

    const ctx = { appUrl: appUrl(), ...context };
    const subject = renderTemplate(tpl.subject, ctx);
    const html = renderTemplate(tpl.html, ctx);
    const res = await sendSystemMail({ to, subject, html });
    return res;
  } catch (err) {
    console.warn(`[systemEmail] ${key} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Ensure every default template exists in the DB (used on boot + admin list).
async function ensureSystemEmailTemplates() {
  for (const t of SYSTEM_EMAILS) {
    await SystemEmailTemplate.updateOne(
      { key: t.key },
      { $setOnInsert: { key: t.key, name: t.name, description: t.description, subject: t.subject, html: t.html, enabled: true } },
      { upsert: true }
    ).catch(() => {});
  }
}

module.exports = { sendSystemEmail, ensureSystemEmailTemplates, resolveTemplate };
