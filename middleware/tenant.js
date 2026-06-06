const { verifyMembership, touchMembership } = require("../services/orgService");

const ORG_OPTIONAL_PREFIXES = ["/api/orgs", "/api/auth/me"];

/** Paths where JWT may omit orgId (org picker / create / switch). */
function pathAllowsNoOrg(req) {
  const paths = new Set();
  const original = (req.originalUrl || req.url || "").split("?")[0];
  if (original) paths.add(original);
  if (req.path) paths.add(req.path);
  const mounted = `${req.baseUrl || ""}${req.path || ""}`.replace(/\/+$/, "") || "";
  if (mounted) paths.add(mounted);

  return [...paths].some((path) =>
    ORG_OPTIONAL_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)),
  );
}

async function resolveOrganization(req, res, next) {
  const orgId = req.authPayload?.orgId;
  const needsOrg = !pathAllowsNoOrg(req);

  if (!orgId) {
    req.tenantId = null;
    req.organization = null;
    if (needsOrg) {
      return res.status(403).json({
        error: "Please select or create an organization first.",
        code: "ORG_REQUIRED",
      });
    }
    return next();
  }

  const membership = await verifyMembership(req.user._id, orgId);
  if (!membership?.organization || membership.organization.status === "archived") {
    return res.status(403).json({ error: "You do not have access to this organization." });
  }

  req.organization = membership.organization;
  req.tenantId = membership.organization._id;
  req.orgMembership = membership;
  await touchMembership(req.user._id, orgId);
  next();
}

function tenantId(req) {
  return req.tenantId || req.user?._id;
}

function orgFilter(req) {
  return { organization: tenantId(req) };
}

function leadFilter(req) {
  if (req.user?.role === "admin" && !req.tenantId) return {};
  const base = { owner: req.user._id };
  if (req.tenantId) base.organization = req.tenantId;
  return base;
}

module.exports = { pathAllowsNoOrg, resolveOrganization, tenantId, orgFilter, leadFilter };
