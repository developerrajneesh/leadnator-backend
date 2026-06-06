const { PLANS } = require("../config/plans");
const Lead = require("../models/Lead");

/**
 * Require a specific feature flag on the user's current plan.
 *
 *   router.post("/generate", protect, requireFeature("ai"), handler)
 */
exports.requireFeature = (feature) => (req, res, next) => {
  const plan = PLANS[req.user?.plan?.id || "starter"];
  if (!plan?.features?.[feature]) {
    return res.status(402).json({
      error: `Your ${plan?.name || "current"} plan doesn't include "${feature}". Please upgrade.`,
      upgrade: true,
      feature,
    });
  }
  next();
};

/**
 * Enforce the per-plan lead limit.
 * Apply on routes that *create* leads.
 */
exports.checkLeadLimit = async (req, res, next) => {
  try {
    const plan = PLANS[req.user?.plan?.id || "starter"];
    if (!isFinite(plan.leadLimit)) return next(); // unlimited

    const count = await Lead.countDocuments({ owner: req.user._id });
    if (count >= plan.leadLimit) {
      return res.status(402).json({
        error: `Lead limit reached for ${plan.name} plan (${plan.leadLimit}). Please upgrade.`,
        upgrade: true,
        limit: plan.leadLimit,
        current: count,
      });
    }
    next();
  } catch (e) {
    next(e);
  }
};
