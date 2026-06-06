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

    org.status = "archived";
    await org.save();

    // respond with success and the archived org id
    res.json({ success: true, id: orgId });
  } catch (err) { next(err); }
});

module.exports = router;
