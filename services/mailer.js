// Shared "system" mailer — transactional mail that Leadnator itself sends
// (password reset, booking/calendar confirmations, etc.).
//
// PRIMARY provider: Resend (https://resend.com) via RESEND_API_KEY.
// FALLBACK: Amazon SES (AWS SDK) — used only if RESEND_API_KEY is not set or a
// Resend send fails, so existing setups keep working.
//
// Per-customer marketing email is unaffected — that still sends from each
// workspace's own verified SES domain (see services/sesSend.js + EmailConfig).
//
// Env:
//   RESEND_API_KEY          Resend API key (primary)
//   MAIL_FROM               verified sender, e.g. "Leadnator <notifications@leadnator.com>"
//   AWS_REGION / AWS_*      SES fallback (optional)

const nodemailer = require("nodemailer");
const { SESClient, SendRawEmailCommand } = require("@aws-sdk/client-ses");
const { Resend } = require("resend");

let transporter;      // SES transporter — undefined = unbuilt, null = unconfigured
let resendClient;     // Resend client — undefined = unbuilt, null = no key

function getResend() {
  if (resendClient !== undefined) return resendClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("[mailer] RESEND_API_KEY not set — system mail will use the SES fallback.");
    resendClient = null;
  } else {
    resendClient = new Resend(key);
  }
  return resendClient;
}

function getMailer() {
  if (transporter !== undefined) return transporter;
  const region = process.env.AWS_REGION || process.env.SES_REGION;
  if (!region) { transporter = null; return null; }
  const ses = new SESClient({
    region,
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
        : undefined,
  });
  transporter = nodemailer.createTransport({ SES: { ses, aws: { SendRawEmailCommand } } });
  return transporter;
}

// The verified "From" address. Defaults to Leadnator's notifications sender.
function defaultFrom() {
  return (
    process.env.MAIL_FROM ||
    process.env.SMTP_FROM ||
    "Leadnator <notifications@leadnator.com>"
  );
}

// Best-effort send. Tries Resend first, falls back to SES. Returns
// { ok:false, skipped:true } when neither provider is configured so callers
// can stay silent in dev instead of throwing.
async function sendSystemMail({ to, subject, html, text, from, replyTo }) {
  if (!to) return { ok: false, skipped: true };
  const fromAddr = from || defaultFrom();

  // 1) Resend (primary)
  const resend = getResend();
  if (resend) {
    try {
      const { data, error } = await resend.emails.send({
        from: fromAddr,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text: text || undefined,
        replyTo: replyTo || undefined,
      });
      if (error) throw new Error(error.message || JSON.stringify(error));
      return { ok: true, messageId: data?.id, provider: "resend" };
    } catch (e) {
      console.warn("[mailer] Resend send failed, falling back to SES:", e.message);
    }
  }

  // 2) Amazon SES (fallback)
  const t = getMailer();
  if (!t) return { ok: false, skipped: true };
  const info = await t.sendMail({ from: fromAddr, to, subject, html, text, replyTo: replyTo || undefined });
  return { ok: true, messageId: info.messageId, provider: "ses" };
}

module.exports = { getMailer, sendSystemMail, defaultFrom };
