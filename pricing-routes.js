const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const Plan = require("./models/Plan");
const Subscription = require("./models/Subscription");
const Invoice = require("./models/Invoice");
const User = require("./models/User");
const { ownerOnly } = require("./middleware/auth");

const router = express.Router();

// Billing actions are owner-only — a TeamMember should never be able to
// charge the account or cancel its subscription.
router.use("/order",  ownerOnly);
router.use("/verify", ownerOnly);
router.use("/cancel", ownerOnly);

const KEY_ID     = process.env.RAZORPAY_KEY_ID || "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

const razorpay = (KEY_ID && KEY_SECRET)
  ? new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET })
  : null;

// Pricing config — durations + multipliers + discounts
const DURATIONS = [
  { id: "monthly",  label: "Monthly",  discount: 0,    multiplier: 1,  months: 1  },
  { id: "quarter",  label: "3 Months", discount: 0.05, multiplier: 3,  months: 3  },
  { id: "half",     label: "6 Months", discount: 0.10, multiplier: 6,  months: 6  },
  { id: "yearly",   label: "Yearly",   discount: 0.15, multiplier: 12, months: 12, bestValue: true },
];

function findDuration(id) { return DURATIONS.find((d) => d.id === id) || DURATIONS[0]; }

// Compute total amount for plan + duration (in INR rupees, then converted to paise for Razorpay)
function computeAmount(plan, duration) {
  const base = plan.price * duration.multiplier;
  return Math.round(base * (1 - duration.discount));
}

function nextInvoiceNumber() {
  const ts = Date.now().toString(36).toUpperCase();
  return `INV-${ts}-${Math.floor(Math.random() * 9999).toString().padStart(4, "0")}`;
}

// ---------- Plans + durations (public-ish — needs auth though) ----------
router.get("/plans", async (_req, res, next) => {
  try {
    const plans = await Plan.find().sort({ price: 1 });
    res.json({ plans, durations: DURATIONS });
  } catch (err) { next(err); }
});

// ---------- Public client config ----------
router.get("/config", (_req, res) => {
  res.json({ keyId: KEY_ID, currency: "INR", enabled: !!razorpay });
});

// ---------- Create Razorpay order ----------
router.post("/order", async (req, res, next) => {
  try {
    if (!razorpay) {
      return res.status(500).json({ error: "Razorpay is not configured on the server" });
    }
    const { planKey, durationId } = req.body || {};
    if (!planKey || !durationId) return res.status(400).json({ error: "planKey and durationId required" });

    const plan = await Plan.findOne({ key: planKey });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const duration = findDuration(durationId);
    const amountRupees = computeAmount(plan, duration);
    const amountPaise  = amountRupees * 100;

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `rcpt_${req.user._id.toString().slice(-8)}_${Date.now().toString(36)}`,
      notes: {
        userId: req.user._id.toString(),
        planKey: plan.key,
        durationId: duration.id,
      },
    });

    // Persist a "pending" subscription that we'll activate after verification
    await Subscription.create({
      user: req.user._id,
      planKey: plan.key,
      planName: plan.name,
      duration: duration.id,
      months: duration.months,
      amount: amountRupees,
      status: "pending",
      razorpayOrderId: order.id,
    });

    res.json({
      order, // contains id, amount (paise), currency
      amount: amountRupees,
      duration,
      plan: { key: plan.key, name: plan.name, price: plan.price },
      keyId: KEY_ID,
    });
  } catch (err) { next(err); }
});

// ---------- Verify payment ----------
router.post("/verify", async (req, res, next) => {
  try {
    if (!KEY_SECRET) return res.status(500).json({ error: "Razorpay not configured" });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment fields" });
    }

    const expected = crypto
      .createHmac("sha256", KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: "Signature mismatch — payment not verified" });
    }

    const sub = await Subscription.findOne({ user: req.user._id, razorpayOrderId: razorpay_order_id });
    if (!sub) return res.status(404).json({ error: "Subscription not found for this order" });

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + sub.months * 30 * 86400000);

    // Mark any existing active subs as cancelled (single-active-sub model)
    await Subscription.updateMany(
      { user: req.user._id, status: "active", _id: { $ne: sub._id } },
      { $set: { status: "cancelled", cancelledAt: new Date() } }
    );

    sub.status = "active";
    sub.razorpayPaymentId = razorpay_payment_id;
    sub.razorpaySignature = razorpay_signature;
    sub.startedAt = startedAt;
    sub.expiresAt = expiresAt;
    await sub.save();

    // Reflect plan on the user doc (denormalized for fast enforcement) and end
    // any free trial now that they're a paying customer.
    await User.findByIdAndUpdate(req.user._id, {
      plan: sub.planName,
      planKey: sub.planKey,
      subscriptionActive: true,
      trialEndsAt: null,
    });

    // Create an invoice
    const invoice = await Invoice.create({
      user: req.user._id,
      subscription: sub._id,
      number: nextInvoiceNumber(),
      planName: sub.planName,
      duration: sub.duration,
      amount: sub.amount,
      currency: "INR",
      status: "paid",
      razorpayPaymentId: razorpay_payment_id,
      paidAt: startedAt,
    });

    // Payment-success system email (fire-and-forget).
    try {
      const { sendSystemEmail } = require("./services/systemEmail");
      sendSystemEmail("payment_success", {
        to: req.user.email,
        context: {
          user: { name: req.user.name, email: req.user.email, phone: req.user.phone || "" },
          plan: { name: sub.planName }, amount: sub.amount, months: sub.months,
          expiresAt: new Date(expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }),
        },
      });
    } catch { /* non-fatal */ }

    res.json({ verified: true, subscription: sub.toJSON(), invoice });
  } catch (err) { next(err); }
});

// ---------- Payment failed (called by the client when Razorpay reports failure) ----------
router.post("/payment-failed", async (req, res) => {
  try {
    const { planKey = "", amount = 0 } = req.body || {};
    const plan = planKey ? await Plan.findOne({ key: planKey }) : null;
    const { sendSystemEmail } = require("./services/systemEmail");
    await sendSystemEmail("payment_failed", {
      to: req.user.email,
      context: {
        user: { name: req.user.name, email: req.user.email, phone: req.user.phone || "" },
        plan: { name: plan?.name || "your" }, amount: amount || plan?.price || 0,
      },
    });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// ---------- Current subscription ----------
router.get("/current", async (req, res, next) => {
  try {
    const sub = await Subscription
      .findOne({ user: req.user._id, status: "active" })
      .sort({ createdAt: -1 });
    res.json({ subscription: sub });
  } catch (err) { next(err); }
});

// ---------- Cancel current subscription ----------
router.post("/cancel", async (req, res, next) => {
  try {
    const sub = await Subscription.findOne({ user: req.user._id, status: "active" });
    if (!sub) return res.status(404).json({ error: "No active subscription to cancel" });
    sub.status = "cancelled";
    sub.cancelledAt = new Date();
    await sub.save();
    // Drop the paid flag so enforcement falls back to Starter/expired.
    await User.findByIdAndUpdate(req.user._id, { subscriptionActive: false });
    res.json({ subscription: sub.toJSON() });
  } catch (err) { next(err); }
});

// ---------- Invoices ----------
router.get("/invoices", async (req, res, next) => {
  try {
    const list = await Invoice.find({ user: req.user._id }).sort({ paidAt: -1 });
    res.json({ invoices: list });
  } catch (err) { next(err); }
});

// ---------- History (subscriptions + cancellations as a timeline) ----------
router.get("/history", async (req, res, next) => {
  try {
    const subs = await Subscription.find({ user: req.user._id }).sort({ createdAt: -1 });
    const events = [];
    for (const s of subs) {
      if (s.status === "active" || s.status === "expired") {
        events.push({
          event: `Subscribed to ${s.planName}`,
          amount: s.amount,
          date: s.startedAt,
        });
      }
      if (s.status === "cancelled" && s.cancelledAt) {
        events.push({
          event: `Cancelled ${s.planName}`,
          amount: 0,
          date: s.cancelledAt,
        });
      }
    }
    events.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ history: events });
  } catch (err) { next(err); }
});

module.exports = router;
