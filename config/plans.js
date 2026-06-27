// Plan definitions — pricing, feature flags & usage limits. This is the single
// source of truth: the DB `Plan` docs (pricing page) are synced from here
// (scripts/sync-plans.js) and the enforcement middleware reads these limits.

const GB = 1024 * 1024 * 1024;
const UNLIMITED = Infinity;

const PLANS = {
  starter: {
    id: "starter",
    key: "starter",
    name: "Starter",
    price: 499,
    popular: false,
    tagline: "For solo founders getting started",
    trialDays: 2, // new users get a 2-day free Starter trial
    limits: {
      leads: 1000,
      workspaces: 1,
      teamMembers: UNLIMITED,
      emailMonthly: 1000,
      emailDaily: 100,
      metaCampaignRunsMonthly: 20,
      whatsappMessagesDaily: 100,
      whatsappCampaignsMonthly: 15,
      storageBytes: 1 * GB,
    },
    features: {
      metaAds: true,
      metaAi: false,
      instagram: true,
      instagramAi: false,
      whatsapp: true,
      whatsappManualChatbot: false,
      whatsappAi: false,
      aiAssist: false,
      aiTools: false,
      aiChatbot: false,
      googleCalendar: true,
      autopilot: true,
      api: "none",            // none | basic | advanced
      integrations: "limited", // limited | unlimited
      liveChat: false,
      personalAssist: false,
    },
    // Shown on the pricing card.
    display: [
      "Up to 1,000 leads",
      "Meta Ads — 20 campaign runs/mo",
      "Instagram — limited automations",
      "WhatsApp — 100 msgs/day · 15 campaigns/mo",
      "Email — 1,000/mo (100/day)",
      "Calendar + Google Meet sync",
      "1 GB storage",
      "Unlimited Autopilot",
      "Ticket support",
      "1 workspace",
      "Unlimited staff members",
    ],
    disabledDisplay: [
      "WhatsApp chatbot",
      "AI tools & AI assistance",
      "API access",
      "Live chat & personal support",
    ],
  },

  growth: {
    id: "growth",
    key: "growth",
    name: "Growth",
    price: 999,
    popular: true,
    tagline: "For growing teams scaling outreach",
    trialDays: 0,
    limits: {
      leads: 10000,
      workspaces: 3,
      teamMembers: UNLIMITED,
      emailMonthly: 10000,
      emailDaily: 1000,
      metaCampaignRunsMonthly: UNLIMITED,
      whatsappMessagesDaily: UNLIMITED,
      whatsappCampaignsMonthly: UNLIMITED,
      storageBytes: 1 * GB,
    },
    features: {
      metaAds: true,
      metaAi: false,
      instagram: true,
      instagramAi: false,
      whatsapp: true,
      whatsappManualChatbot: true,
      whatsappAi: false,
      aiAssist: false,
      aiTools: false,
      aiChatbot: false,
      googleCalendar: true,
      autopilot: true,
      api: "basic",
      integrations: "limited",
      liveChat: true,
      personalAssist: false,
    },
    display: [
      "Up to 10,000 leads",
      "Meta Ads — unlimited campaign runs",
      "Instagram — unlimited automations",
      "WhatsApp + manual chatbot",
      "Email — 10,000/mo (1,000/day)",
      "Calendar + Google Meet sync",
      "1 GB storage",
      "Unlimited Autopilot",
      "Basic API access",
      "Ticket + Live chat support",
      "3 workspaces",
      "Unlimited staff members",
    ],
    disabledDisplay: [
      "AI chatbot & AI assistance",
      "AI tools",
      "Personal assistance",
    ],
  },

  pro: {
    id: "pro",
    key: "pro",
    name: "Pro",
    price: 1999,
    popular: false,
    tagline: "Everything, with AI — for serious growth",
    trialDays: 0,
    limits: {
      leads: UNLIMITED,
      workspaces: 6,
      teamMembers: UNLIMITED,
      emailMonthly: UNLIMITED,
      emailDaily: UNLIMITED,
      metaCampaignRunsMonthly: UNLIMITED,
      whatsappMessagesDaily: UNLIMITED,
      whatsappCampaignsMonthly: UNLIMITED,
      storageBytes: 1 * GB,
    },
    features: {
      metaAds: true,
      metaAi: true,
      instagram: true,
      instagramAi: true,
      whatsapp: true,
      whatsappManualChatbot: true,
      whatsappAi: true,
      aiAssist: true,
      aiTools: true,
      aiChatbot: true,
      googleCalendar: true,
      autopilot: true,
      api: "advanced",
      integrations: "unlimited",
      liveChat: true,
      personalAssist: true,
    },
    display: [
      "Unlimited leads",
      "Meta Ads — unlimited + AI assist",
      "Instagram — unlimited + AI assist",
      "WhatsApp + AI chatbot & AI assist",
      "Unlimited email",
      "Calendar + Google Meet sync",
      "1 GB storage",
      "Unlimited Autopilot",
      "AI tools access",
      "Advanced API access",
      "Ticket + Live chat + personal assistance",
      "6 workspaces",
      "Unlimited staff members",
    ],
    disabledDisplay: [],
  },
};

const DURATIONS = {
  monthly: { id: "monthly", months: 1,  discount: 0    },
  quarter: { id: "quarter", months: 3,  discount: 0.05 },
  half:    { id: "half",    months: 6,  discount: 0.10 },
  yearly:  { id: "yearly",  months: 12, discount: 0.15, bestValue: true },
};

const PLAN_ORDER = ["starter", "growth", "pro"];

function priceFor(planId, durationId) {
  const plan = PLANS[planId];
  const dur  = DURATIONS[durationId];
  if (!plan || !dur) throw new Error("Invalid plan or duration");
  const base  = plan.price * dur.months;
  const after = Math.round(base * (1 - dur.discount));
  return { base, after, months: dur.months, discount: dur.discount };
}

// Map a stored plan NAME ("Pro") or key ("pro") to a canonical plan key.
function planKeyFromAny(value) {
  if (!value) return null;
  const v = String(value).toLowerCase();
  if (PLANS[v]) return v;
  const byName = PLAN_ORDER.find((k) => PLANS[k].name.toLowerCase() === v);
  return byName || null;
}

// The DB Plan documents (pricing page) derived from this config.
function dbPlanDocs() {
  return PLAN_ORDER.map((k) => {
    const p = PLANS[k];
    return {
      key: p.key,
      name: p.name,
      price: p.price,
      leadLimit: p.limits.leads === UNLIMITED ? -1 : p.limits.leads,
      popular: !!p.popular,
      tagline: p.tagline,
      features: p.display,
      disabled: p.disabledDisplay,
    };
  });
}

module.exports = { PLANS, DURATIONS, PLAN_ORDER, UNLIMITED, priceFor, planKeyFromAny, dbPlanDocs };
