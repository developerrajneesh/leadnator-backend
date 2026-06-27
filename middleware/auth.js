const jwt = require("jsonwebtoken");
const User = require("../models/User");
const TeamMember = require("../models/TeamMember");

// Verify JWT — attach user to req.user. Two flavours of token:
//   - Owner / admin:  { id: <userId>, role: <user.role> }
//   - Team member:    { id: <memberId>, kind: "member" }
//
// For team members we still set `req.user` to the parent OWNER User so
// that all existing route handlers (which scope data by `req.user._id`)
// keep working transparently — the member acts inside the owner's
// tenant. The member's own document is exposed as `req.member` for any
// permission check that needs it.
exports.protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Not authenticated" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.kind === "member") {
      const member = await TeamMember.findById(decoded.id);
      if (!member) return res.status(401).json({ error: "Member not found" });
      if (member.status === "suspended") {
        return res.status(403).json({ error: "Your team account is suspended." });
      }
      if (member.status === "pending") {
        return res.status(403).json({ error: "Your invite is still pending." });
      }

      const owner = await User.findById(member.owner);
      if (!owner || owner.status === "deleted") {
        return res.status(401).json({ error: "Owner account no longer exists" });
      }
      if (owner.status === "suspended") {
        return res.status(403).json({ error: "Your team owner's account has been suspended." });
      }
      if (owner.status === "paused") {
        return res.status(403).json({ error: "Your team owner's account is paused." });
      }

      req.user   = owner;     // tenant scoping — same data as the owner sees
      req.member = member;    // identity / permissions
      return next();
    }

    const user = await User.findById(decoded.id);
    if (!user || user.status === "deleted") return res.status(401).json({ error: "User not found" });
    if (user.status === "suspended") return res.status(403).json({ error: "Your account has been suspended. Please contact support.", suspended: true });
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

// Block team members from owner-only endpoints. Owners (no req.member)
// pass through; members get a clear 403.
exports.ownerOnly = (req, res, next) => {
  if (req.member) {
    return res.status(403).json({
      error: "Owner-only — your team account doesn't have access to this resource.",
    });
  }
  next();
};

// Per-(module, sub-route) permission gate. Mirrors the frontend
// permissions map on TeamMember.permissions[moduleKey][subRouteKey].
// Owners always pass; members get 403 when the bit is unset.
exports.requirePermission = (moduleKey, subRouteKey) => (req, res, next) => {
  if (!req.member) return next();
  const perms = req.member.permissions || {};
  if (perms?.[moduleKey]?.[subRouteKey]) return next();
  return res.status(403).json({
    error: `You don't have permission for ${moduleKey}/${subRouteKey}. Ask your team owner to grant it.`,
  });
};
