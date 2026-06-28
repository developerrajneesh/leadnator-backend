// Default system-email templates. The admin can override subject/html per key
// (stored in SystemEmailTemplate); these are the fallbacks + the "reset to
// default" source. All bodies support {{dot.path}} variables resolved from the
// context passed to sendSystemEmail (e.g. {{user.name}}, {{user.email}}).

function layout(bodyHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a;background:#f6f7fb">
  <div style="text-align:center;margin-bottom:14px">
    <span style="font-size:24px;font-weight:800;letter-spacing:-.5px;color:#2563eb">Lead<span style="color:#f97316">nator</span></span>
  </div>
  <div style="background:#ffffff;border:1px solid #eceef3;border-radius:16px;padding:28px">
    ${bodyHtml}
  </div>
  <p style="font-size:11px;color:#9ca3af;text-align:center;margin-top:16px;line-height:1.6">
    © Leadnator · You're receiving this because you have a Leadnator account.<br/>
    Need help? Reply to this email or visit your dashboard.
  </p>
</div>`;
}

function btn(href, label) {
  return `<p style="margin:24px 0;text-align:center">
    <a href="${href}" style="background:linear-gradient(135deg,#7c3aed,#ec4899);color:#fff;padding:12px 26px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block">${label}</a>
  </p>`;
}

const h2 = (t) => `<h2 style="margin:0 0 12px;font-size:20px;color:#0f172a">${t}</h2>`;
const p  = (t) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#334155">${t}</p>`;

// key → default template. `vars` is just documentation shown in the admin UI.
const SYSTEM_EMAILS = [
  {
    key: "account_created",
    name: "Welcome / account created",
    description: "Sent right after a user signs up.",
    vars: ["user.name", "user.email", "user.phone", "trialDays", "appUrl"],
    subject: "Welcome to Leadnator, {{user.name}} 🎉",
    html: layout(
      h2("Welcome aboard, {{user.name}}! 🎉") +
      p("Your Leadnator account is ready. You're on a <strong>{{trialDays}}-day free Starter trial</strong> — explore every module, no credit card needed.") +
      btn("{{appUrl}}/dashboard/overview", "Go to your dashboard") +
      p("Need a hand getting started? Just reply to this email.")
    ),
  },
  {
    key: "password_reset",
    name: "Password reset",
    description: "Sent when a user requests a password reset.",
    vars: ["user.name", "user.email", "resetLink"],
    subject: "Reset your Leadnator password",
    html: layout(
      h2("Reset your password") +
      p("Hi {{user.name}}, click the button below to set a new password. This link expires in 1 hour.") +
      btn("{{resetLink}}", "Reset password") +
      p('Or copy this link into your browser:<br/><a href="{{resetLink}}" style="color:#7c3aed;word-break:break-all">{{resetLink}}</a>') +
      p("If you didn't request this, you can ignore this email — your password won't change.")
    ),
  },
  {
    key: "account_blocked",
    name: "Account suspended",
    description: "Sent when an admin suspends a user account.",
    vars: ["user.name", "user.email"],
    subject: "Your Leadnator account has been suspended",
    html: layout(
      h2("Account suspended") +
      p("Hi {{user.name}}, your Leadnator account ({{user.email}}) has been suspended and access is temporarily disabled.") +
      p("If you think this is a mistake, please reply to this email and our team will help you out.")
    ),
  },
  {
    key: "account_unblocked",
    name: "Account reactivated",
    description: "Sent when an admin un-suspends a user account.",
    vars: ["user.name", "user.email", "appUrl"],
    subject: "Your Leadnator account is active again ✅",
    html: layout(
      h2("You're back in 🎉") +
      p("Hi {{user.name}}, your Leadnator account has been reactivated. You can log in and pick up right where you left off.") +
      btn("{{appUrl}}/dashboard/overview", "Open Leadnator")
    ),
  },
  {
    key: "payment_success",
    name: "Payment successful",
    description: "Sent after a successful subscription payment.",
    vars: ["user.name", "plan.name", "amount", "months", "expiresAt", "appUrl"],
    subject: "Payment received — {{plan.name}} plan is active",
    html: layout(
      h2("Payment successful ✅") +
      p("Thanks {{user.name}}! Your payment of <strong>₹{{amount}}</strong> for the <strong>{{plan.name}}</strong> plan ({{months}} month(s)) was received.") +
      p("Your plan is active until <strong>{{expiresAt}}</strong>.") +
      btn("{{appUrl}}/pricing/current", "View subscription")
    ),
  },
  {
    key: "payment_failed",
    name: "Payment failed",
    description: "Sent when a subscription payment fails.",
    vars: ["user.name", "plan.name", "amount", "appUrl"],
    subject: "Your Leadnator payment didn't go through",
    html: layout(
      h2("Payment failed") +
      p("Hi {{user.name}}, we couldn't process your payment of <strong>₹{{amount}}</strong> for the <strong>{{plan.name}}</strong> plan.") +
      p("No charge was made. You can try again with a different method.") +
      btn("{{appUrl}}/pricing/plans", "Try again")
    ),
  },
  {
    key: "booking_confirmed",
    name: "Booking confirmed",
    description: "Sent to the person who books via a public booking link.",
    vars: ["user.name", "user.email", "booking.title", "booking.when", "booking.host", "booking.meetLink"],
    subject: "Booking confirmed: {{booking.title}}",
    html: layout(
      h2("Your booking is confirmed ✅") +
      p("Hi {{user.name}}, your <strong>{{booking.title}}</strong> with {{booking.host}} is confirmed.") +
      p("🗓️ <strong>{{booking.when}}</strong>") +
      p('Meeting link: <a href="{{booking.meetLink}}" style="color:#7c3aed">{{booking.meetLink}}</a>')
    ),
  },
  {
    key: "subscription_reminder_2d",
    name: "Subscription ending — 2 days before",
    description: "Sent ~2 days before a subscription expires.",
    vars: ["user.name", "plan.name", "expiresAt", "appUrl"],
    subject: "Your {{plan.name}} plan expires in 2 days",
    html: layout(
      h2("Your plan expires soon") +
      p("Hi {{user.name}}, your <strong>{{plan.name}}</strong> plan will expire on <strong>{{expiresAt}}</strong> (in about 2 days).") +
      p("Renew now to avoid any interruption to your campaigns, automations and inbox.") +
      btn("{{appUrl}}/pricing/plans", "Renew now")
    ),
  },
  {
    key: "subscription_reminder_5h",
    name: "Subscription ending — 5 hours before",
    description: "Sent ~5 hours before a subscription expires.",
    vars: ["user.name", "plan.name", "expiresAt", "appUrl"],
    subject: "Last reminder: your {{plan.name}} plan expires in 5 hours",
    html: layout(
      h2("Expiring in a few hours ⏰") +
      p("Hi {{user.name}}, your <strong>{{plan.name}}</strong> plan expires at <strong>{{expiresAt}}</strong> — about 5 hours from now.") +
      p("Renew now so your workspace keeps running without a break.") +
      btn("{{appUrl}}/pricing/plans", "Renew now")
    ),
  },
];

// Resolve {{dot.path}} tokens from a context object.
function renderTemplate(str, ctx = {}) {
  return String(str || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    return v == null ? "" : String(v);
  });
}

function defaultByKey(key) {
  return SYSTEM_EMAILS.find((t) => t.key === key) || null;
}

module.exports = { SYSTEM_EMAILS, renderTemplate, defaultByKey };
