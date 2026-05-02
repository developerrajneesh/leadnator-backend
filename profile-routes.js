const express = require("express");
const crypto = require("crypto");
const User = require("./models/User");
const UserSettings = require("./models/UserSettings");
const ApiKey = require("./models/ApiKey");
const TeamMember = require("./models/TeamMember");
const Team = require("./models/Team");

const router = express.Router();

// ---------- USER PROFILE (info) ----------
router.put("/info", async (req, res, next) => {
  try {
    const { name, email, phone, company } = req.body || {};
    const update = {};
    if (typeof name === "string") update.name = name.trim();
    if (typeof email === "string" && email.trim()) update.email = email.trim().toLowerCase();
    if (typeof phone === "string") update.phone = phone;
    if (typeof company === "string") update.company = company;

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true });
    res.json({ user: user.toJSON() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "Email already in use." });
    next(err);
  }
});

router.put("/password", async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both passwords required" });
    if (newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });

    const u = await User.findById(req.user._id).select("+password");
    if (!u) return res.status(404).json({ error: "User not found" });
    const ok = await u.comparePassword(currentPassword);
    if (!ok) return res.status(401).json({ error: "Current password is wrong" });

    u.password = newPassword;
    await u.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- SETTINGS (account/notifications/sms/profile bio) ----------
router.get("/settings", async (req, res, next) => {
  try {
    let s = await UserSettings.findOne({ user: req.user._id });
    if (!s) s = await UserSettings.create({ user: req.user._id });
    res.json({ settings: s });
  } catch (err) { next(err); }
});

router.put("/settings", async (req, res, next) => {
  try {
    const { _id, id, user, ...patch } = req.body || {};
    const s = await UserSettings.findOneAndUpdate(
      { user: req.user._id }, { ...patch, user: req.user._id },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json({ settings: s });
  } catch (err) { next(err); }
});

router.put("/settings/notifications", async (req, res, next) => {
  try {
    const next_ = req.body || {};
    const s = await UserSettings.findOneAndUpdate(
      { user: req.user._id }, { $set: { notifications: next_ }, user: req.user._id },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ settings: s });
  } catch (err) { next(err); }
});

router.put("/settings/sms", async (req, res, next) => {
  try {
    const sms = req.body || {};
    const s = await UserSettings.findOneAndUpdate(
      { user: req.user._id }, { $set: { sms }, user: req.user._id },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ settings: s });
  } catch (err) { next(err); }
});

// ---------- API KEYS ----------
router.get("/api-keys", async (req, res, next) => {
  try {
    const keys = await ApiKey.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json({ keys });
  } catch (err) { next(err); }
});

router.post("/api-keys", async (req, res, next) => {
  try {
    const { name, env = "test" } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const env_ = env === "live" ? "live" : "test";
    const random = crypto.randomBytes(24).toString("hex");
    const secret = `ldn_${env_}_${random}`;
    const prefix = `${secret.slice(0, 12)}…${secret.slice(-4)}`;
    const k = await ApiKey.create({ user: req.user._id, name, prefix, secret });
    // Return the actual secret ONCE so the user can copy it.
    res.status(201).json({ key: { ...k.toJSON(), secret } });
  } catch (err) { next(err); }
});

router.delete("/api-keys/:id", async (req, res, next) => {
  try {
    const r = await ApiKey.deleteOne({ _id: req.params.id, user: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Key not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// ---------- TEAMS (groups that hold members) ----------
router.get("/teams", async (req, res, next) => {
  try {
    const teams = await Team.find({ owner: req.user._id }).sort({ createdAt: 1 });
    // Member counts per team — single aggregation pass so the UI can show
    // "5 members" next to each team name without N extra round-trips.
    const counts = await TeamMember.aggregate([
      { $match: { owner: req.user._id } },
      { $group: { _id: "$team", count: { $sum: 1 } } },
    ]);
    const byTeamId = counts.reduce((a, c) => ((a[String(c._id)] = c.count), a), {});
    res.json({
      teams: teams.map((t) => ({ ...t.toJSON(), memberCount: byTeamId[t.id] || 0 })),
    });
  } catch (err) { next(err); }
});

router.get("/teams/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    // Reject obvious bad ids before Mongoose throws a CastError.
    if (!id || !/^[a-f0-9]{24}$/i.test(id)) {
      return res.status(400).json({ error: "Invalid team id" });
    }
    const t = await Team.findOne({ _id: id, owner: req.user._id });
    if (!t) return res.status(404).json({ error: "Team not found" });
    const members = await TeamMember.find({ owner: req.user._id, team: t._id }).sort({ createdAt: 1 });
    res.json({ team: t.toJSON(), members: members.map((m) => m.toJSON()) });
  } catch (err) { next(err); }
});

router.post("/teams", async (req, res, next) => {
  try {
    const { name, description = "", color = "#7c3aed" } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "Team name is required" });
    const t = await Team.create({
      owner: req.user._id,
      name: name.trim(),
      description: description.trim(),
      color,
    });
    res.status(201).json({ team: t.toJSON() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You already have a team with that name." });
    next(err);
  }
});

router.put("/teams/:id", async (req, res, next) => {
  try {
    const { name, description, color } = req.body || {};
    const update = {};
    if (typeof name === "string" && name.trim()) update.name = name.trim();
    if (typeof description === "string") update.description = description.trim();
    if (typeof color === "string") update.color = color;
    const t = await Team.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      update,
      { new: true, runValidators: true }
    );
    if (!t) return res.status(404).json({ error: "Team not found" });
    res.json({ team: t.toJSON() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You already have a team with that name." });
    next(err);
  }
});

router.delete("/teams/:id", async (req, res, next) => {
  try {
    // Refuse to delete a team that still has members — the caller should
    // reassign or remove members first. Avoids orphaning the `team` ref.
    const count = await TeamMember.countDocuments({ owner: req.user._id, team: req.params.id });
    if (count > 0) {
      return res.status(400).json({ error: `This team still has ${count} member${count === 1 ? "" : "s"}. Remove or reassign them first.` });
    }
    const r = await Team.deleteOne({ _id: req.params.id, owner: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Team not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// ---------- TEAM MEMBERS ----------
// Supports two list modes:
//   GET /team                → all members across all teams (legacy, owner-first)
//   GET /team?teamId=:teamId → only members in that team
router.get("/team", async (req, res, next) => {
  try {
    const filter = { owner: req.user._id };
    if (req.query.teamId) filter.team = req.query.teamId;
    const members = await TeamMember.find(filter).sort({ createdAt: 1 });

    // Owner is shown first only when we're listing the whole workspace
    // (not when filtering by team).
    const includeOwner = !req.query.teamId;
    const base = includeOwner ? [{
      id: req.user._id.toString(),
      name: req.user.name,
      email: req.user.email,
      role: "Owner",
      status: "active",
      isOwner: true,
    }] : [];
    res.json({ members: [...base, ...members.map((m) => m.toJSON())] });
  } catch (err) { next(err); }
});

router.post("/team", async (req, res, next) => {
  try {
    const {
      teamId,
      name, email, phone = "", password = "",
      role = "Member",
      permissions = {},
      status,
    } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: "Name and email are required" });
    if (!teamId) return res.status(400).json({ error: "Pick a team before adding a member" });
    if (role === "Owner") return res.status(400).json({ error: "Cannot invite another Owner" });
    if (password && password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // Verify the team actually belongs to this user — prevents cross-tenant assignment.
    const team = await Team.findOne({ _id: teamId, owner: req.user._id });
    if (!team) return res.status(404).json({ error: "Team not found" });

    // Active immediately when we have a password to sign in with, pending otherwise.
    const initialStatus = status || (password ? "active" : "pending");

    // `createWithPassword` runs the pre-save hook so the password is
    // properly bcrypt-hashed before insert.
    const m = await TeamMember.createWithPassword({
      owner: req.user._id,
      team: team._id,
      name,
      email: email.trim().toLowerCase(),
      phone,
      password,
      role,
      permissions,
      status: initialStatus,
    });

    res.status(201).json({ member: m.toJSON() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "That email is already on your team." });
    next(err);
  }
});

router.put("/team/:id", async (req, res, next) => {
  try {
    const { _id, id, owner, password, ...patch } = req.body || {};
    // Load the doc first so the save hook can hash a new password.
    const m = await TeamMember.findOne({ _id: req.params.id, owner: req.user._id });
    if (!m) return res.status(404).json({ error: "Member not found" });

    Object.assign(m, patch);
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
      m.password = password;           // hashed by pre-save hook
    }
    await m.save();
    res.json({ member: m.toJSON() });
  } catch (err) { next(err); }
});

router.delete("/team/:id", async (req, res, next) => {
  try {
    const r = await TeamMember.deleteOne({ _id: req.params.id, owner: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Member not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

module.exports = router;
