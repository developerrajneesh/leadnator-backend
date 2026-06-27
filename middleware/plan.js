const { PLANS, planKeyFromAny, UNLIMITED } = require("../config/plans");
const Lead = require("../models/Lead");

// ---------------------------------------------------------------------------
// Access resolution
// ---------------------------------------------------------------------------
// Resolve the effective plan + trial/expiry state for a user. Designed to never
// brick legacy accounts: a user with no trial info and no paid flag keeps the
// plan stored on their doc.
function accessState(user) {
  const now = Date.now();
  const paid = !!user?.subscriptionActive;
  const planKey = planKeyFromAny(user?.planKey) || planKeyFromAny(user?.plan) || "starter";
  const trialEndsAt = user?.trialEndsAt ? new Date(user.trialEndsAt).getTime() : null;

  if (paid) {
    return { planKey, plan: PLANS[planKey], trial: false, expired: false };
  }
  if (trialEndsAt && now < trialEndsAt) {
    return { planKey: "starter", plan: PLANS.starter, trial: true, expired: false, trialEndsAt };
  }
  if (trialEndsAt && now >= trialEndsAt) {
    // Trial finished with no payment → paywall writes/usage.
    return { planKey: "starter", plan: PLANS.starter, trial: false, expired: true, trialEndsAt };
  }
  // Legacy / pre-trial account — honor their stored plan, don't lock them out.
  return { planKey, plan: PLANS[planKey], trial: false, expired: false };
}

function planForUser(user) { return accessState(user).plan; }

const API_RANK = { none: 0, basic: 1, advanced: 2 };

function expiredResponse(res, state) {
  return res.status(402).json({
    error: "Your free trial has ended. Subscribe to a plan to keep using Leadnator.",
    upgrade: true,
    trialExpired: true,
  });
}

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------

// Block any usage once the trial has lapsed with no subscription.
function requireActive(req, res, next) {
  const state = accessState(req.user);
  if (state.expired) return expiredResponse(res, state);
  next();
}

// Require a boolean feature flag (whatsapp, aiTools, aiChatbot, metaAi, …).
function requireFeature(feature, label) {
  return (req, res, next) => {
    const state = accessState(req.user);
    if (state.expired) return expiredResponse(res, state);
    if (!state.plan?.features?.[feature]) {
      return res.status(402).json({
        error: `Your ${state.plan?.name || "current"} plan doesn't include ${label || `"${feature}"`}. Please upgrade.`,
        upgrade: true,
        feature,
      });
    }
    next();
  };
}

// Require at least a given API tier (basic | advanced).
function requireApi(minLevel = "basic") {
  return (req, res, next) => {
    const state = accessState(req.user);
    if (state.expired) return expiredResponse(res, state);
    const have = API_RANK[state.plan?.features?.api || "none"] || 0;
    if (have < (API_RANK[minLevel] || 1)) {
      return res.status(402).json({
        error: `API access requires a higher plan. Your ${state.plan?.name} plan has ${state.plan?.features?.api || "no"} API access.`,
        upgrade: true,
        feature: "api",
      });
    }
    next();
  };
}

// Enforce the per-plan lead limit. Apply on routes that CREATE leads.
async function checkLeadLimit(req, res, next) {
  try {
    const state = accessState(req.user);
    if (state.expired) return expiredResponse(res, state);
    const limit = state.plan.limits.leads;
    if (!isFinite(limit)) return next();
    const count = await Lead.countDocuments({ owner: req.user._id });
    if (count >= limit) {
      return res.status(402).json({
        error: `Lead limit reached for the ${state.plan.name} plan (${limit.toLocaleString()}). Please upgrade.`,
        upgrade: true, limit, current: count,
      });
    }
    next();
  } catch (e) { next(e); }
}

// Enforce the per-plan workspace (organization) limit. Apply on org creation.
function checkWorkspaceLimit(Organization) {
  return async (req, res, next) => {
    try {
      const state = accessState(req.user);
      if (state.expired) return expiredResponse(res, state);
      const limit = state.plan.limits.workspaces;
      if (!isFinite(limit)) return next();
      const count = await Organization.countDocuments({ createdBy: req.user._id, status: { $ne: "archived" } });
      if (count >= limit) {
        return res.status(402).json({
          error: `Your ${state.plan.name} plan allows ${limit} workspace${limit === 1 ? "" : "s"}. Upgrade to add more.`,
          upgrade: true, limit, current: count,
        });
      }
      next();
    } catch (e) { next(e); }
  };
}

// Email quota: returns how many sends remain this month / today, or Infinity.
async function emailQuota(req) {
  const EmailMessage = require("../models/EmailMessage");
  const state = accessState(req.user);
  const { emailMonthly, emailDaily } = state.plan.limits;
  if (!isFinite(emailMonthly) && !isFinite(emailDaily)) {
    return { monthlyLeft: Infinity, dailyLeft: Infinity, plan: state.plan, expired: state.expired };
  }
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const base = { user: req.user._id, direction: "outbound" };
  const [monthCount, dayCount] = await Promise.all([
    isFinite(emailMonthly) ? EmailMessage.countDocuments({ ...base, ts: { $gte: startOfMonth } }) : Promise.resolve(0),
    isFinite(emailDaily)   ? EmailMessage.countDocuments({ ...base, ts: { $gte: startOfDay } })   : Promise.resolve(0),
  ]);
  return {
    monthlyLeft: isFinite(emailMonthly) ? Math.max(0, emailMonthly - monthCount) : Infinity,
    dailyLeft:   isFinite(emailDaily)   ? Math.max(0, emailDaily - dayCount)     : Infinity,
    plan: state.plan, expired: state.expired,
  };
}

// Middleware: block a send when the email quota is exhausted. `need` may be a
// number (e.g. recipient count) read from req via getNeed(req).
function checkEmailQuota(getNeed) {
  return async (req, res, next) => {
    try {
      const q = await emailQuota(req);
      if (q.expired) return expiredResponse(res, accessState(req.user));
      const need = Math.max(1, typeof getNeed === "function" ? getNeed(req) || 1 : 1);
      if (q.dailyLeft < need) {
        return res.status(402).json({ error: `Daily email limit reached for the ${q.plan.name} plan. Try again tomorrow or upgrade.`, upgrade: true, dailyLeft: q.dailyLeft });
      }
      if (q.monthlyLeft < need) {
        return res.status(402).json({ error: `Monthly email limit reached for the ${q.plan.name} plan. Please upgrade.`, upgrade: true, monthlyLeft: q.monthlyLeft });
      }
      next();
    } catch (e) { next(e); }
  };
}

// WhatsApp quota: how many outbound messages remain today and how many
// campaigns remain this month, or Infinity. Counts are account-wide (by user).
async function whatsappQuota(req) {
  const WhatsAppMessage = require("../models/WhatsAppMessage");
  const WhatsAppCampaign = require("../models/WhatsAppCampaign");
  const state = accessState(req.user);
  const dailyMsg = state.plan.limits.whatsappMessagesDaily;
  const monthlyCamp = state.plan.limits.whatsappCampaignsMonthly;
  if (!isFinite(dailyMsg) && !isFinite(monthlyCamp)) {
    return { messagesLeftToday: Infinity, campaignsLeftThisMonth: Infinity, plan: state.plan, expired: state.expired };
  }
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const [msgToday, campThisMonth] = await Promise.all([
    isFinite(dailyMsg)    ? WhatsAppMessage.countDocuments({ user: req.user._id, direction: "outbound", ts: { $gte: startOfDay } }) : Promise.resolve(0),
    isFinite(monthlyCamp) ? WhatsAppCampaign.countDocuments({ user: req.user._id, createdAt: { $gte: startOfMonth } }) : Promise.resolve(0),
  ]);
  return {
    messagesLeftToday:      isFinite(dailyMsg)    ? Math.max(0, dailyMsg - msgToday)        : Infinity,
    campaignsLeftThisMonth: isFinite(monthlyCamp) ? Math.max(0, monthlyCamp - campThisMonth): Infinity,
    plan: state.plan, expired: state.expired,
  };
}

module.exports = {
  accessState,
  planForUser,
  requireActive,
  requireFeature,
  requireApi,
  checkLeadLimit,
  checkWorkspaceLimit,
  emailQuota,
  checkEmailQuota,
  whatsappQuota,
};
