const express = require("express");
const crypto = require("crypto");
const User = require("./models/User");
const UserSettings = require("./models/UserSettings");
const ApiKey = require("./models/ApiKey");
const TeamMember = require("./models/TeamMember");
const Team = require("./models/Team");
const AssignmentRule = require("./models/AssignmentRule");
const { ownerOnly } = require("./middleware/auth");

const router = express.Router();

// Owner-only sub-trees. These are sensitive surfaces a TeamMember
// should never reach — billing/team management/API keys. Frontend
// hides them, but we re-check here so a member can't fish around by
// hitting the URLs directly.
router.use("/api-keys", ownerOnly);
router.use("/teams",    ownerOnly);
router.use("/team",     ownerOnly);
router.use("/assignment-rules", ownerOnly);

// Normalise an incoming auto-assign config into the shape Team expects.
function cleanAutoAssign(input) {
  if (!input || typeof input !== "object") return undefined;
  const out = {};
  if (typeof input.enabled === "boolean") out.enabled = input.enabled;
  if (typeof input.isDefault === "boolean") out.isDefault = input.isDefault;
  if (Array.isArray(input.members)) {
    out.members = input.members.filter((x) => /^[a-f0-9]{24}$/i.test(String(x)));
  }
  return out;
}

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
    const json = s.toJSON();
    // Team members keep their OWN table-column prefs, separate from the owner
    // (and from each other) — overlay them onto the shared settings payload.
    if (req.member) {
      json.leadColumns = req.member.leadColumns || [];
      json.leadCardFields = req.member.leadCardFields || [];
    }
    res.json({ settings: json });
  } catch (err) { next(err); }
});

router.put("/settings", async (req, res, next) => {
  try {
    const { _id, id, user, ...patch } = req.body || {};

    // For a team member, table-column prefs are stored on THEIR own doc — the
    // owner's settings are never touched. Other (owner-level) settings sent by
    // a member are ignored.
    if (req.member) {
      const memberPatch = {};
      if (Array.isArray(patch.leadColumns))    memberPatch.leadColumns = patch.leadColumns;
      if (Array.isArray(patch.leadCardFields)) memberPatch.leadCardFields = patch.leadCardFields;
      if (Object.keys(memberPatch).length) {
        await TeamMember.updateOne({ _id: req.member._id, owner: req.user._id }, { $set: memberPatch });
        Object.assign(req.member, memberPatch);
      }
      let s = await UserSettings.findOne({ user: req.user._id });
      if (!s) s = await UserSettings.create({ user: req.user._id });
      const json = s.toJSON();
      json.leadColumns = req.member.leadColumns || [];
      json.leadCardFields = req.member.leadCardFields || [];
      return res.json({ settings: json });
    }

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
    const { name, description = "", color = "#7c3aed", autoAssign } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "Team name is required" });
    const aa = cleanAutoAssign(autoAssign);
    const t = await Team.create({
      owner: req.user._id,
      name: name.trim(),
      description: description.trim(),
      color,
      ...(aa ? { autoAssign: aa } : {}),
    });
    // Only one catch-all default team per owner.
    if (aa?.isDefault) {
      await Team.updateMany({ owner: req.user._id, _id: { $ne: t._id } }, { "autoAssign.isDefault": false });
    }
    res.status(201).json({ team: t.toJSON() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You already have a team with that name." });
    next(err);
  }
});

router.put("/teams/:id", async (req, res, next) => {
  try {
    const { name, description, color, autoAssign } = req.body || {};
    const update = {};
    if (typeof name === "string" && name.trim()) update.name = name.trim();
    if (typeof description === "string") update.description = description.trim();
    if (typeof color === "string") update.color = color;
    const aa = cleanAutoAssign(autoAssign);
    if (aa) {
      if (typeof aa.enabled === "boolean") update["autoAssign.enabled"] = aa.enabled;
      if (typeof aa.isDefault === "boolean") update["autoAssign.isDefault"] = aa.isDefault;
      if (Array.isArray(aa.members)) update["autoAssign.members"] = aa.members;
    }
    const t = await Team.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      update,
      { new: true, runValidators: true }
    );
    if (!t) return res.status(404).json({ error: "Team not found" });
    // Keep a single catch-all default across the owner's teams.
    if (aa?.isDefault) {
      await Team.updateMany({ owner: req.user._id, _id: { $ne: t._id } }, { "autoAssign.isDefault": false });
    }
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

    // Email must be unique across BOTH users and team members. If a Leadnator
    // user account already owns this email, it can't also be a team member —
    // otherwise the two identities collide at login.
    const normEmail = email.trim().toLowerCase();
    const userWithEmail = await User.findOne({ email: normEmail });
    if (userWithEmail) {
      return res.status(409).json({ error: "That email already has a Leadnator user account — it can't also be added as a team member. Use a different email." });
    }

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

    // Block changing a member's email to one that already belongs to a user.
    if (typeof patch.email === "string" && patch.email.trim().toLowerCase() !== m.email) {
      const clash = await User.findOne({ email: patch.email.trim().toLowerCase() });
      if (clash) return res.status(409).json({ error: "That email already has a Leadnator user account — pick a different email." });
    }

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

// ---------- LEAD ROUTING RULES (source/tag → team) ----------
router.get("/assignment-rules", async (req, res, next) => {
  try {
    const rules = await AssignmentRule.find({ owner: req.user._id }).sort({ priority: 1, createdAt: 1 });
    res.json({ rules: rules.map((r) => r.toJSON()) });
  } catch (err) { next(err); }
});

router.post("/assignment-rules", async (req, res, next) => {
  try {
    const { matchSource = "", matchTag = "", team, priority = 0, enabled = true } = req.body || {};
    if (!team || !/^[a-f0-9]{24}$/i.test(String(team))) return res.status(400).json({ error: "Pick a team for the rule" });
    const t = await Team.findOne({ _id: team, owner: req.user._id });
    if (!t) return res.status(404).json({ error: "Team not found" });
    if (!String(matchSource).trim() && !String(matchTag).trim()) {
      return res.status(400).json({ error: "Add a source or a tag to match on" });
    }
    const rule = await AssignmentRule.create({
      owner: req.user._id,
      organization: req.tenantId || null,
      matchSource: String(matchSource).trim(),
      matchTag: String(matchTag).trim(),
      team: t._id,
      priority: Number(priority) || 0,
      enabled: !!enabled,
    });
    res.status(201).json({ rule: rule.toJSON() });
  } catch (err) { next(err); }
});

router.put("/assignment-rules/:id", async (req, res, next) => {
  try {
    const { matchSource, matchTag, team, priority, enabled } = req.body || {};
    const update = {};
    if (typeof matchSource === "string") update.matchSource = matchSource.trim();
    if (typeof matchTag === "string") update.matchTag = matchTag.trim();
    if (typeof priority !== "undefined") update.priority = Number(priority) || 0;
    if (typeof enabled === "boolean") update.enabled = enabled;
    if (team) {
      if (!/^[a-f0-9]{24}$/i.test(String(team))) return res.status(400).json({ error: "Invalid team" });
      const t = await Team.findOne({ _id: team, owner: req.user._id });
      if (!t) return res.status(404).json({ error: "Team not found" });
      update.team = t._id;
    }
    const rule = await AssignmentRule.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id }, update, { new: true, runValidators: true }
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    res.json({ rule: rule.toJSON() });
  } catch (err) { next(err); }
});

router.delete("/assignment-rules/:id", async (req, res, next) => {
  try {
    const r = await AssignmentRule.deleteOne({ _id: req.params.id, owner: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Rule not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

module.exports = router;
