// Shared "system" mailer — used for transactional mail that Leadnator itself
// sends (password reset, booking/calendar confirmations, campaign blasts).
//
// Sends via Amazon SES using the AWS SDK (NOT SMTP). Per-user sending still
// uses each customer's own SMTP creds in EmailConfig — this helper is only for
// mail that comes from Leadnator's own verified domain (leadnator.com).
//
// Required env:
//   AWS_REGION              e.g. us-east-1  (the region your SES is set up in)
//   AWS_ACCESS_KEY_ID       IAM key with ses:SendRawEmail   (optional if the
//   AWS_SECRET_ACCESS_KEY   host has an IAM role attached)
//   MAIL_FROM               verified sender, e.g. "Leadnator" <no-reply@leadnator.com>

const nodemailer = require("nodemailer");
const { SESClient, SendRawEmailCommand } = require("@aws-sdk/client-ses");

let transporter; // undefined = not built yet, null = not configured

function getMailer() {
  if (transporter !== undefined) return transporter;

  const region = process.env.AWS_REGION || process.env.SES_REGION;
  if (!region) {
    console.warn("[mailer] AWS_REGION not set — system emails disabled.");
    transporter = null;
    return null;
  }

  const ses = new SESClient({
    region,
    // If keys are absent, the SDK falls back to the host's IAM role /
    // shared credentials chain — handy on EC2 / ECS.
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

  transporter = nodemailer.createTransport({ SES: { ses, aws: { SendRawEmailCommand } } });
  return transporter;
}

// The verified "From" address. Falls back to the old SMTP_FROM so nothing
// breaks if MAIL_FROM hasn't been set yet.
function defaultFrom() {
  return (
    process.env.MAIL_FROM ||
    process.env.SMTP_FROM ||
    '"Leadnator" <no-reply@leadnator.com>'
  );
}

// Best-effort send. Returns {ok,false,skipped} when SES isn't configured so
// callers can stay silent in dev instead of throwing.
async function sendSystemMail({ to, subject, html, text, from, replyTo }) {
  const t = getMailer();
  if (!t || !to) return { ok: false, skipped: true };
  const info = await t.sendMail({
    from: from || defaultFrom(),
    to,
    subject,
    html,
    text,
    replyTo: replyTo || undefined,
  });
  return { ok: true, messageId: info.messageId };
}

module.exports = { getMailer, sendSystemMail, defaultFrom };
