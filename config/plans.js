// Plan definitions — pricing & feature limits.
// Durations with progressive discounts.

const PLANS = {
  starter: {
    id: "starter",
    name: "Starter",
    price: 299,
    leadLimit: 100,
    features: {
      basicLeads: true,
      basicEmail: true,
      ai: false,
      metaAds: false,
      advancedEmail: false,
      automation: false,
      api: false,
      teamAccess: false,
    },
  },
  growth: {
    id: "growth",
    name: "Growth",
    price: 499,
    popular: true,
    leadLimit: 500,
    features: {
      basicLeads: true,
      basicEmail: true,
      ai: true,
      metaAds: true,
      advancedEmail: true,
      automation: false,
      api: false,
      teamAccess: false,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: 999,
    leadLimit: Infinity,
    features: {
      basicLeads: true,
      basicEmail: true,
      ai: true,
      metaAds: true,
      advancedEmail: true,
      automation: true,
      api: true,
      teamAccess: true,
    },
  },
};

const DURATIONS = {
  monthly: { id: "monthly", months: 1,  discount: 0    },
  quarter: { id: "quarter", months: 3,  discount: 0.05 },
  half:    { id: "half",    months: 6,  discount: 0.10 },
  yearly:  { id: "yearly",  months: 12, discount: 0.15, bestValue: true },
};

function priceFor(planId, durationId) {
  const plan = PLANS[planId];
  const dur  = DURATIONS[durationId];
  if (!plan || !dur) throw new Error("Invalid plan or duration");
  const base  = plan.price * dur.months;
  const after = Math.round(base * (1 - dur.discount));
  return { base, after, months: dur.months, discount: dur.discount };
}

module.exports = { PLANS, DURATIONS, priceFor };
