const Organization = require("../models/Organization");
const OrgMembership = require("../models/OrgMembership");
const User = require("../models/User");

/** e.g. "Rajneesh" → "Rajneesh's workspace" */
function workspaceNameFromUser(name) {
  const n = String(name || "").trim();
  if (!n) return "My workspace";
  if (/\s+workspace$/i.test(n)) return n;
  const base = n.replace(/'s$/i, "").replace(/'$/, "").trim() || n;
  return `${base}'s workspace`;
}

function organizationPublic(org) {
  return {
    id: org._id.toString(),
    name: org.name,
    loginEmail: org.loginEmail || "",
    phone: org.phone || "",
    logoUrl: org.logoUrl || "",
  };
}

async function createOrganization(userId, data = {}) {
  const payload = typeof data === "string" ? { name: data } : data;
  const name = String(payload.name || "").trim();
  const loginEmail = String(payload.loginEmail || "").trim().toLowerCase();
  const password = String(payload.password || "");
  const phone = String(payload.phone || "").trim();
  const logoUrl = String(payload.logoUrl || "").trim();

  if (!name) {
    const err = new Error("Organization name is required");
    err.status = 400;
    throw err;
  }

  const wantsLogin = !!(loginEmail || password);
  if (wantsLogin) {
    if (!loginEmail) {
      const err = new Error("Workspace login email is required");
      err.status = 400;
      throw err;
    }
    if (!password || password.length < 6) {
      const err = new Error("Password must be at least 6 characters");
      err.status = 400;
      throw err;
    }
    const emailTaken = await Organization.findOne({ loginEmail });
    if (emailTaken) {
      const err = new Error("This workspace email is already in use");
      err.status = 409;
      throw err;
    }
    const userEmail = await User.findOne({ email: loginEmail });
    if (userEmail) {
      const err = new Error("This email is already used for a personal account — use a different workspace email");
      err.status = 409;
      throw err;
    }
  }

  const org = await Organization.create({
    name,
    createdBy: userId,
    ...(loginEmail ? { loginEmail, password } : {}),
    phone,
    logoUrl,
  });
  await OrgMembership.create({
    organization: org._id,
    user: userId,
    role: "owner",
    lastAccessedAt: new Date(),
  });
  return org;
}

async function listOrganizationsForUser(userId) {
  const memberships = await OrgMembership.find({ user: userId })
    .populate("organization")
    .sort({ lastAccessedAt: -1 })
    .lean();

  return memberships
    .filter((m) => m.organization && m.organization.status !== "archived")
    .map((m) => ({
      ...organizationPublic(m.organization),
      role: m.role,
      lastAccessedAt: m.lastAccessedAt,
      createdAt: m.organization.createdAt,
    }));
}

async function ensureDefaultOrganization(userId, { name: signupName } = {}) {
  let orgs = await listOrganizationsForUser(userId);
  if (orgs.length > 0) {
    await migrateIntegrationsToOrg(userId, orgs[0].id);
    return orgs;
  }

  const user = await User.findById(userId).select("name company");
  const label =
    user?.company?.trim()
    || workspaceNameFromUser(signupName || user?.name);
  const org = await createOrganization(userId, { name: label });
  await migrateIntegrationsToOrg(userId, org._id);
  return listOrganizationsForUser(userId);
}

function primaryOrganizationPayload(organizations) {
  const first = organizations?.[0];
  if (!first) return { organization: null, orgId: null };
  return {
    organization: { id: first.id, name: first.name },
    orgId: first.id,
  };
}

/** Login/signup: only embed org in JWT when user has exactly one workspace. */
function authOrganizationsPayload(organizations) {
  const list = organizations || [];
  if (list.length !== 1) {
    return {
      organizations: list,
      organization: null,
      orgId: null,
      needsOrgSelection: true,
    };
  }
  const { organization, orgId } = primaryOrganizationPayload(list);
  return {
    organizations: list,
    organization,
    orgId,
    needsOrgSelection: false,
  };
}

async function verifyMembership(userId, orgId) {
  return OrgMembership.findOne({ user: userId, organization: orgId }).populate("organization");
}

async function touchMembership(userId, orgId) {
  await OrgMembership.updateOne(
    { user: userId, organization: orgId },
    { $set: { lastAccessedAt: new Date() } },
  );
}

/** Move legacy per-user integrations onto the user's first organization. */
async function migrateIntegrationsToOrg(userId, orgId) {
  const User = require("../models/User");
  const WhatsAppConnection = require("../models/WhatsAppConnection");
  const InstagramConnection = require("../models/InstagramConnection");
  const EmailConfig = require("../models/EmailConfig");
  const Lead = require("../models/Lead");

  const user = await User.findById(userId).select("+meta");
  const org = await Organization.findById(orgId);
  if (org && user?.meta?.accessToken && !org.meta?.accessToken) {
    org.meta = { ...(org.meta?.toObject?.() || org.meta || {}), ...user.meta.toObject?.() || user.meta };
    await org.save();
  }

  const orgFilter = { $or: [{ organization: { $exists: false } }, { organization: null }] };

  await WhatsAppConnection.updateMany({ user: userId, ...orgFilter }, { $set: { organization: orgId } });
  await InstagramConnection.updateMany({ user: userId, ...orgFilter }, { $set: { organization: orgId } });
  await EmailConfig.updateMany({ user: userId, ...orgFilter }, { $set: { organization: orgId } });
  await Lead.updateMany({ owner: userId, ...orgFilter }, { $set: { organization: orgId } });
}

module.exports = {
  workspaceNameFromUser,
  organizationPublic,
  createOrganization,
  listOrganizationsForUser,
  ensureDefaultOrganization,
  primaryOrganizationPayload,
  authOrganizationsPayload,
  verifyMembership,
  touchMembership,
  migrateIntegrationsToOrg,
};
