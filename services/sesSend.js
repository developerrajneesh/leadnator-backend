// Per-user SES sender — used by the Email Marketing feature (campaigns,
// quick-send, automation/flows). Each user attaches & verifies their OWN
// domain under /email/config; mail goes out from their verified address via
// the SES API (no SMTP creds needed from the user).
//
// NOTE: this is separate from services/mailer.js, which sends Leadnator's own
// *system* mail (password reset, booking confirmations) from no-reply@leadnator.com.

const {
  SESClient,
  SendEmailCommand,
} = require("@aws-sdk/client-ses");

function sesClient() {
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  return new SESClient({
    region,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
  });
}

// The From address to send from. Uses the user's saved sender, else falls back
// to noreply@<their verified domain> so a verified domain alone is enough to
// send (no separate "save sender" step required).
function sesFromAddress(cfg) {
  return cfg.sesFromEmail || (cfg.sesDomain ? `noreply@${cfg.sesDomain}` : "");
}

// Build the SES "Source" header.
function sesSource(cfg) {
  const name = String(cfg.sesFromName || "").replace(/"/g, "");
  const addr = sesFromAddress(cfg);
  return name ? `"${name}" <${addr}>` : addr;
}

// True when the user has a verified domain — that's all we need, since the
// sender defaults to noreply@<domain> when not explicitly set.
function sesReady(cfg) {
  return !!(cfg && cfg.sesDomain && cfg.sesVerified);
}

// Throws a user-friendly error when the config isn't ready to send.
function assertSesReady(cfg) {
  if (!cfg?.sesDomain)
    throw new Error("Attach your sending domain under Email → Config first.");
  if (!cfg.sesVerified)
    throw new Error(
      "Your domain isn't verified yet. Add the DNS records and click Verify."
    );
}

// Send one email via the user's SES identity. Returns { messageId }.
async function sendViaSes(cfg, { to, subject, html, text, replyTo }) {
  assertSesReady(cfg);
  const ses = sesClient();
  const reply = replyTo || cfg.replyTo || "";
  const out = await ses.send(
    new SendEmailCommand({
      Source: sesSource(cfg),
      Destination: { ToAddresses: [to] },
      ReplyToAddresses: reply ? [reply] : undefined,
      Message: {
        Subject: { Data: subject || "", Charset: "UTF-8" },
        Body: {
          Html: { Data: html || "", Charset: "UTF-8" },
          ...(text ? { Text: { Data: text, Charset: "UTF-8" } } : {}),
        },
      },
    })
  );
  return { messageId: out.MessageId || "" };
}

module.exports = { sesClient, sesSource, sesFromAddress, sesReady, assertSesReady, sendViaSes };
