const jwt = require("jsonwebtoken");
const User = require("../models/User");
const TeamMember = require("../models/TeamMember");
const { PLANS } = require("../config/plans");
const { sendSystemEmail } = require("../services/systemEmail");

function signUserToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function signMemberToken(member) {
  return jwt.sign({ id: member._id, kind: "member" }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

exports.signup = async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });

  const exists = await User.findOne({ email });
  if (exists) return res.status(409).json({ error: "Email already in use" });

  // New users get a 2-day free Starter trial.
  const trialDays = PLANS.starter.trialDays || 2;
  const trialEndsAt = new Date(Date.now() + trialDays * 86400000);
  const user = await User.create({
    name, email, password,
    plan: "Starter", planKey: "starter",
    subscriptionActive: false, trialEndsAt,
  });
  const token = signUserToken(user);

  // Welcome / account-created system email (fire-and-forget).
  sendSystemEmail("account_created", {
    to: user.email,
    context: { user: { name: user.name, email: user.email, phone: user.phone || "" }, trialDays },
  });

  res.status(201).json({ token, user: user.toSafeJSON() });
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });

  const normalizedEmail = String(email).trim().toLowerCase();

  // 1. Try the primary User collection (account owners + admins).
  const user = await User.findOne({ email: normalizedEmail }).select("+password");
  if (user) {
    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const token = signUserToken(user);
    return res.json({ token, user: user.toSafeJSON() });
  }

  // 2. Fall back to TeamMember — a sub-account created by an Owner from
  //    Settings → Team. They get a JWT with `kind: "member"` so the auth
  //    middleware knows to scope data under the parent owner's tenant.
  const member = await TeamMember.findOne({ email: normalizedEmail }).select("+password");
  if (member) {
    if (!member.password) {
      return res.status(401).json({ error: "This member has no password set yet. Ask the team owner to set one." });
    }
    if (member.status === "suspended") {
      return res.status(403).json({ error: "Your team account is suspended. Contact your team owner." });
    }
    if (member.status === "pending") {
      return res.status(403).json({ error: "Your invite is still pending — ask your team owner to activate it." });
    }
    const ok = await member.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    // Sanity-check the parent owner is still alive — without them the
    // member has nothing to log into.
    const owner = await User.findById(member.owner);
    if (!owner || owner.status === "deleted") {
      return res.status(403).json({ error: "Your team owner's account is no longer active." });
    }

    const token = signMemberToken(member);
    return res.json({ token, user: member.toSafeJSON() });
  }

  return res.status(401).json({ error: "Invalid credentials" });
};

exports.me = async (req, res) => {
  // For team members, return the member's identity (not the parent owner's).
  if (req.member) return res.json({ user: req.member.toSafeJSON() });
  res.json({ user: req.user.toSafeJSON() });
};
