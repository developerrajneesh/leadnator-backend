const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Verify JWT — attach user to req.user
exports.protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not authenticated" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || user.status === "deleted") return res.status(401).json({ error: "User not found" });
    if (user.status === "paused") return res.status(403).json({ error: "Account paused" });

    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

// Role-based guard
exports.authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ error: "Forbidden — insufficient role" });
  }
  next();
};
