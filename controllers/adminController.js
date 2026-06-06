const User = require("../models/User");
const Lead = require("../models/Lead");

exports.listUsers = async (_req, res) => {
  const users = await User.find().sort({ createdAt: -1 });
  res.json({ items: users.map((u) => u.toSafeJSON()) });
};

exports.changePlan = async (req, res) => {
  const { planId, duration } = req.body;
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { "plan.id": planId, "plan.duration": duration || "monthly" },
    { new: true }
  );
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user.toSafeJSON());
};

exports.setStatus = async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user.toSafeJSON());
};

exports.stats = async (_req, res) => {
  const [users, leads] = await Promise.all([User.countDocuments(), Lead.countDocuments()]);
  const byPlan = await User.aggregate([{ $group: { _id: "$plan.id", count: { $sum: 1 } } }]);
  res.json({ users, leads, byPlan });
};
