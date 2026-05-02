const jwt = require("jsonwebtoken");
const User = require("../models/User");

function signToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

exports.signup = async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });

  const exists = await User.findOne({ email });
  if (exists) return res.status(409).json({ error: "Email already in use" });

  const user = await User.create({ name, email, password });
  const token = signToken(user);
  res.status(201).json({ token, user: user.toSafeJSON() });
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });

  const user = await User.findOne({ email }).select("+password");
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await user.comparePassword(password);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = signToken(user);
  res.json({ token, user: user.toSafeJSON() });
};

exports.me = async (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
};
