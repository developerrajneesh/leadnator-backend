// Subscription expiry reminder scheduler. Sends two system emails per active
// paid subscription: ~2 days before expiry and ~5 hours before. Each is sent
// once (guarded by remind2dSentAt / remind5hSentAt). Safe to run hourly.

const Subscription = require("../models/Subscription");
const User = require("../models/User");
const { sendSystemEmail } = require("./systemEmail");

function fmtWhen(d) {
  return new Date(d).toLocaleString("en-IN", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" });
}

async function notify(sub, key) {
  const user = await User.findById(sub.user).select("name email phone").lean().catch(() => null);
  if (!user?.email) return;
  await sendSystemEmail(key, {
    to: user.email,
    context: {
      user: { name: user.name, email: user.email, phone: user.phone || "" },
      plan: { name: sub.planName },
      expiresAt: fmtWhen(sub.expiresAt),
    },
  });
}

async function runSubscriptionReminders() {
  const now = Date.now();
  const in5h = new Date(now + 5 * 3600 * 1000);
  const in2d = new Date(now + 48 * 3600 * 1000);

  try {
    // 2-day reminder: expires within 48h (but still more than 5h away).
    const due2d = await Subscription.find({
      status: "active",
      expiresAt: { $gt: in5h, $lte: in2d },
      remind2dSentAt: null,
    });
    for (const s of due2d) { await notify(s, "subscription_reminder_2d"); s.remind2dSentAt = new Date(); await s.save(); }

    // 5-hour reminder: expires within the next 5h.
    const due5h = await Subscription.find({
      status: "active",
      expiresAt: { $gt: new Date(now), $lte: in5h },
      remind5hSentAt: null,
    });
    for (const s of due5h) { await notify(s, "subscription_reminder_5h"); s.remind5hSentAt = new Date(); await s.save(); }

    if (due2d.length || due5h.length) {
      console.log(`[reminders] sent ${due2d.length} 2-day + ${due5h.length} 5-hour subscription reminders`);
    }
  } catch (err) {
    console.warn("[reminders] run failed:", err.message);
  }
}

// Start the hourly scheduler (and a first run shortly after boot).
function startSubscriptionReminders() {
  setTimeout(runSubscriptionReminders, 30 * 1000);          // 30s after boot
  setInterval(runSubscriptionReminders, 60 * 60 * 1000);    // hourly
}

module.exports = { runSubscriptionReminders, startSubscriptionReminders };
