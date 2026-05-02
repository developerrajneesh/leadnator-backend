const { PLANS, DURATIONS, priceFor } = require("../config/plans");
const Subscription = require("../models/Subscription");
const User = require("../models/User");

exports.listPlans = (_req, res) => {
  res.json({
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      leadLimit: isFinite(p.leadLimit) ? p.leadLimit : "unlimited",
      popular: !!p.popular,
      features: p.features,
    })),
    durations: Object.values(DURATIONS),
  });
};

exports.quote = (req, res) => {
  try {
    const q = priceFor(req.query.plan, req.query.duration);
    res.json(q);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

// Naive "subscribe" — in production, hand off to Stripe Checkout.
exports.subscribe = async (req, res) => {
  const { plan, duration } = req.body;
  const pricing = priceFor(plan, duration);

  const sub = await Subscription.create({
    user:     req.user._id,
    planId:   plan,
    duration,
    amount:   pricing.after,
    status:   "active",
    expiresAt:new Date(Date.now() + pricing.months * 30 * 24 * 60 * 60 * 1000),
  });

  await User.findByIdAndUpdate(req.user._id, {
    plan: {
      id:        plan,
      duration,
      startedAt: new Date(),
      expiresAt: sub.expiresAt,
    },
  });

  res.status(201).json({ subscription: sub });
};

exports.cancel = async (req, res) => {
  const sub = await Subscription.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { status: "cancelled" },
    { new: true }
  );
  if (!sub) return res.status(404).json({ error: "Not found" });
  res.json(sub);
};
