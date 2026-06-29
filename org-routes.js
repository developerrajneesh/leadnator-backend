const express = require("express");
const jwt = require("jsonwebtoken");
const Organization = require("./models/Organization");
const {
  createOrganization,
  ensureDefaultOrganization,
  organizationPublic,
  verifyMembership,
  touchMembership,
} = require("./services/orgService");
const { accessState } = require("./middleware/plan");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

function issueToken(req, orgId) {
  if (req.member) {
    return jwt.sign(
      { id: req.member._id.toString(), kind: "member", orgId: orgId || undefined },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    );
  }
  return jwt.sign(
    { id: req.user._id.toString(), role: req.user.role, orgId: orgId || undefined },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

router.get("/", async (req, res, next) => {
  try {
    const organizations = await ensureDefaultOrganization(req.user._id);
    res.json({
      organizations,
      currentOrgId: req.authPayload?.orgId || null,
      organization: req.organization
        ? organizationPublic(req.organization)
        : null,
    });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const loginEmail = String(req.body?.loginEmail || "").trim();
    const password = String(req.body?.password || "");
    const phone = String(req.body?.phone || "").trim();

    if (!loginEmail || !password) {
      return res.status(400).json({ error: "Workspace login email and password are required" });
    }

    // Enforce the per-plan workspace limit (Starter 1 · Growth 3 · Pro unlimited).
    const st = accessState(req.user);
    if (st.expired) {
      return res.status(402).json({ error: "Your free trial has ended. Subscribe to add workspaces.", upgrade: true, trialExpired: true });
    }
    const wsLimit = st.plan.limits.workspaces;
    if (isFinite(wsLimit)) {
      const count = await Organization.countDocuments({ createdBy: req.user._id, status: { $ne: "archived" } });
      if (count >= wsLimit) {
        return res.status(402).json({ error: `Your ${st.plan.name} plan allows ${wsLimit} workspace${wsLimit === 1 ? "" : "s"}. Upgrade to add more.`, upgrade: true, limit: wsLimit, current: count });
      }
    }

    const org = await createOrganization(req.user._id, {
      name,
      loginEmail,
      password,
      phone,
    });

    res.status(201).json({
      organization: organizationPublic(org),
    });
  } catch (err) {
    if (!err.status) err.status = 500;
    next(err);
  }
});

router.post("/switch", async (req, res, next) => {
  try {
    const orgId = String(req.body?.organizationId || req.body?.orgId || "").trim();
    if (!orgId) return res.status(400).json({ error: "organizationId is required" });

    const membership = await verifyMembership(req.user._id, orgId);
    if (!membership) return res.status(403).json({ error: "Organization not found or access denied" });

    await touchMembership(req.user._id, orgId);

    res.json({
      token: issueToken(req, orgId),
      organization: organizationPublic(membership.organization),
    });
  } catch (err) { next(err); }
});

// Update workspace branding (name / logo) — owner or platform admin only.
router.put("/:id", async (req, res, next) => {
  try {
    const orgId = String(req.params.id || "").trim();
    if (!orgId) return res.status(400).json({ error: "organization id is required" });

    const membership = await verifyMembership(req.user._id, orgId);
    if (!membership) return res.status(404).json({ error: "Organization not found or access denied" });
    if (membership.role !== "owner" && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the workspace owner or admin can update this workspace" });
    }

    const set = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (name) set.name = name;
    }
    if (req.body?.logoUrl !== undefined) set.logoUrl = String(req.body.logoUrl || "").trim();

    const org = await Organization.findByIdAndUpdate(orgId, { $set: set }, { new: true });
    if (!org) return res.status(404).json({ error: "Organization not found" });
    res.json({ organization: organizationPublic(org) });
  } catch (err) { next(err); }
});

// Archive (soft-delete) an organization — only owner or platform admin can do this
router.delete("/:id", async (req, res, next) => {
  try {
    const orgId = String(req.params.id || "").trim();
    if (!orgId) return res.status(400).json({ error: "organization id is required" });

    const membership = await verifyMembership(req.user._id, orgId);
    if (!membership) return res.status(404).json({ error: "Organization not found or access denied" });

    // Only the workspace owner (role === 'owner') or a platform admin user can archive
    if (membership.role !== "owner" && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the workspace owner or admin can delete this organization" });
    }

    const org = await Organization.findById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    // Keep at least one organization — refuse to delete the last active one.
    const activeCount = await Organization.countDocuments({
      createdBy: org.createdBy,
      status: { $ne: "archived" },
    });
    if (activeCount <= 1) {
      return res.status(400).json({ error: "You must keep at least one organization." });
    }

    org.status = "archived";
    await org.save();

    // respond with success and the archived org id
    res.json({ success: true, id: orgId });
  } catch (err) { next(err); }
});

module.exports = router;
