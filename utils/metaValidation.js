/**
 * Meta Ads Validation Constants and Functions
 * Ensures Campaign → Ad Set → Ad Creative compatibility
 */

// Campaign Objectives (v23.0 - OUTCOME_* format)
const OUTCOME_AWARENESS = "OUTCOME_AWARENESS";
const OUTCOME_TRAFFIC = "OUTCOME_TRAFFIC";
const OUTCOME_ENGAGEMENT = "OUTCOME_ENGAGEMENT";
const OUTCOME_LEADS = "OUTCOME_LEADS";
const OUTCOME_SALES = "OUTCOME_SALES";
const OUTCOME_APP_PROMOTION = "OUTCOME_APP_PROMOTION";

const CAMPAIGN_OBJECTIVES = {
  OUTCOME_AWARENESS,
  OUTCOME_TRAFFIC,
  OUTCOME_ENGAGEMENT,
  OUTCOME_LEADS,
  OUTCOME_SALES,
  OUTCOME_APP_PROMOTION,
};

// Array of all campaign objectives for easy iteration (v23.0)
const CAMPAIGN_OBJECTIVES_ARRAY = [
  OUTCOME_AWARENESS,
  OUTCOME_TRAFFIC,
  OUTCOME_ENGAGEMENT,
  OUTCOME_LEADS,
  OUTCOME_SALES,
  OUTCOME_APP_PROMOTION,
];

// Ad Set Destination Types
const DESTINATION_TYPES = {
  WEBSITE: "WEBSITE",
  APP: "APP",
  LEAD_FORM: "LEAD_FORM",
};

// CTA Types by Destination (Meta Marketing API v23)
const CTA_TYPES = {
  WEBSITE: [
    // General/Website CTAs
    "LEARN_MORE",
    "SHOP_NOW",
    "SIGN_UP",
    "BOOK_TRAVEL",
    "BOOK_NOW",
    "CONTACT_US",
    "GET_QUOTE",
    "SUBSCRIBE",
    "APPLY_NOW",
    "BUY_NOW",
    "ORDER_NOW",
    "DONATE_NOW",
    "REQUEST_TIME",
    "GET_OFFER",
    "NO_BUTTON",
    "CALL_NOW",
    "GET_DIRECTIONS",
    "MESSAGE_PAGE",
    "MESSAGE_US",
    // Video/Media CTAs
    "WATCH_VIDEO",
    "WATCH_MORE",
    "LISTEN_MUSIC",
    "LISTEN_NOW",
    "LISTEN",
    "WATCH",
    // Social Engagement CTAs
    "LIKE_PAGE",
    "FOLLOW",
    "SHARE",
    "COMMENT",
    "INTERESTED",
    "EVENT_RSVP",
    // Messaging CTAs
    "WHATSAPP_MESSAGE",
    "SEND_MESSAGE",
    // Lead Generation CTAs
    "GET_STARTED",
    "REQUEST_QUOTE",
    // E-commerce CTAs
    "SHOP_ON_FACEBOOK",
    "VIEW_CATALOG",
    // Event CTAs
    "FIND_YOUR_GROUP",
    "SEE_MORE",
    // Other
    "OPEN_LINK"
  ],
  APP: [
    "DOWNLOAD",
    "INSTALL_APP",
    "INSTALL_MOBILE_APP",
    "USE_APP",
    "PLAY_GAME",
    "OPEN_LINK"
  ],
  LEAD_FORM: [
    "SIGN_UP",
    "APPLY_NOW",
    "LEARN_MORE",
    "GET_QUOTE",
    "SUBSCRIBE",
    "GET_STARTED",
    "REQUEST_QUOTE"
  ],
};

// Campaign Objective → Destination Type Mapping (v23.0)
const OBJECTIVE_TO_DESTINATION = {
  [CAMPAIGN_OBJECTIVES.OUTCOME_AWARENESS]: [DESTINATION_TYPES.WEBSITE],
  [CAMPAIGN_OBJECTIVES.OUTCOME_TRAFFIC]: [DESTINATION_TYPES.WEBSITE],
  [CAMPAIGN_OBJECTIVES.OUTCOME_ENGAGEMENT]: [DESTINATION_TYPES.WEBSITE],
  [CAMPAIGN_OBJECTIVES.OUTCOME_LEADS]: [DESTINATION_TYPES.LEAD_FORM],
  [CAMPAIGN_OBJECTIVES.OUTCOME_SALES]: [DESTINATION_TYPES.WEBSITE],
  [CAMPAIGN_OBJECTIVES.OUTCOME_APP_PROMOTION]: [DESTINATION_TYPES.APP],
};

// Campaign → AdSet Optimization Goals Mapping (v23.0)
// Updated according to new requirements
const CAMPAIGN_ADSET_MAPPING_V23 = {
  [CAMPAIGN_OBJECTIVES.OUTCOME_AWARENESS]: {
    adsetOptimizationGoals: ["AD_RECALL_LIFT", "REACH", "IMPRESSIONS", "THRUPLAY"],
    validCTAs: ["LEARN_MORE", "WATCH_MORE", "LISTEN_NOW", "GET_QUOTE", "SIGN_UP"],
    objectType: ["PAGE", "POST", "VIDEO"],
    destinationTypes: ["ON_AD", "WEBSITE", "INSTAGRAM_PROFILE", "FACEBOOK_PAGE"]
  },
  [CAMPAIGN_OBJECTIVES.OUTCOME_TRAFFIC]: {
    adsetOptimizationGoals: ["LINK_CLICKS", "LANDING_PAGE_VIEWS", "IMPRESSIONS", "REACH"],
    validCTAs: ["LEARN_MORE", "BOOK_NOW", "CONTACT_US", "CALL_NOW", "SHOP_NOW", "GET_OFFER"],
    objectType: ["URL", "PAGE"],
    destinationTypes: ["WEBSITE", "MESSAGING_APPS", "PHONE_CALL", "INSTAGRAM_PROFILE"]
  },
  [CAMPAIGN_OBJECTIVES.OUTCOME_ENGAGEMENT]: {
    adsetOptimizationGoals: ["CONVERSATIONS", "POST_ENGAGEMENT", "THRUPLAY", "PAGE_LIKES", "EVENT_RESPONSES"],
    validCTAs: ["SEND_MESSAGE", "WHATSAPP_MESSAGE", "LEARN_MORE", "CALL_NOW", "LIKE_PAGE", "EVENT_RSVP"],
    objectType: ["PAGE", "POST", "VIDEO", "EVENT"],
    destinationTypes: ["MESSAGING_APPS", "ON_AD", "WEBSITE", "PHONE_CALL"]
  },
  [CAMPAIGN_OBJECTIVES.OUTCOME_LEADS]: {
    adsetOptimizationGoals: ["LEAD_GENERATION", "LINK_CLICKS"],
    validCTAs: ["SIGN_UP", "GET_QUOTE", "APPLY_NOW", "SUBSCRIBE", "LEARN_MORE", "CALL_NOW"],
    objectType: ["PAGE", "FORM", "URL"],
    destinationTypes: ["INSTANT_FORM", "CALLS", "MESSAGING_APPS", "WEBSITE"]
  },
  [CAMPAIGN_OBJECTIVES.OUTCOME_APP_PROMOTION]: {
    adsetOptimizationGoals: ["APP_INSTALLS", "APP_ENGAGEMENT"],
    validCTAs: ["INSTALL_MOBILE_APP", "USE_APP", "PLAY_GAME", "SHOP_NOW", "LISTEN_NOW"],
    objectType: ["APP"],
    destinationTypes: ["APP_STORE", "APP_DEEP_LINK"]
  },
  [CAMPAIGN_OBJECTIVES.OUTCOME_SALES]: {
    adsetOptimizationGoals: ["LANDING_PAGE_VIEWS", "LINK_CLICKS"],
    validCTAs: ["SHOP_NOW", "BUY_NOW", "ORDER_NOW", "BOOK_NOW", "GET_OFFER", "CALL_NOW"],
    objectType: ["URL", "PRODUCT_CATALOG"],
    destinationTypes: ["WEBSITE", "APP", "MESSAGING_APPS", "PHONE_CALL"]
  }
};

/**
 * Validate that Ad Set destination_type matches Campaign objective
 * @param {string} campaignObjective - The campaign objective
 * @param {string} destinationType - The adset destination_type
 * @returns {Object} { valid: boolean, error: string|null }
 */
function validateCampaignToAdSet(campaignObjective, destinationType) {
  if (!campaignObjective) {
    return { valid: false, error: "Campaign objective is required" };
  }

  if (!destinationType) {
    return { valid: false, error: "Ad Set destination_type is required" };
  }

  // Get allowed destination types for this objective
  const allowedDestinations = OBJECTIVE_TO_DESTINATION[campaignObjective];

  if (!allowedDestinations) {
    // If objective not in mapping, default to allowing WEBSITE (most common)
    console.warn(`⚠️ Campaign objective ${campaignObjective} not in validation mapping. Defaulting to WEBSITE.`);
    if (destinationType !== DESTINATION_TYPES.WEBSITE) {
      return {
        valid: false,
        error: `${campaignObjective} campaigns only support WEBSITE destination type. Provided: ${destinationType}`,
      };
    }
    return { valid: true, error: null };
  }

  if (!allowedDestinations.includes(destinationType)) {
    const allowedStr = allowedDestinations.join(" or ");
    return {
      valid: false,
      error: `Campaign objective ${campaignObjective} only supports destination types: ${allowedStr}. Provided: ${destinationType}`,
    };
  }

  return { valid: true, error: null };
}

/**
 * Validate that Ad Creative matches Ad Set destination_type
 * @param {string} destinationType - The adset destination_type
 * @param {Object} creative - The ad creative object
 * @returns {Object} { valid: boolean, error: string|null }
 */
function validateAdSetToCreative(destinationType, creative) {
  if (!destinationType) {
    return { valid: false, error: "Ad Set destination_type is required" };
  }

  if (!creative || !creative.object_story_spec) {
    return { valid: false, error: "Ad creative must include object_story_spec" };
  }

  const oss = creative.object_story_spec;

  switch (destinationType) {
    case DESTINATION_TYPES.WEBSITE:
      // Website ads require: page_id, and either link_data with link OR video_data/video_id
      if (!oss.page_id) {
        return { valid: false, error: "page_id is required for WEBSITE destination ads" };
      }
      
      // Check if video content exists (video_data or video_id)
      const hasVideoContent = oss.video_data || oss.video_id;
      
      // If video content exists, link_data is not required
      if (hasVideoContent) {
        // Validate CTA type in video_data if present
        if (oss.video_data && oss.video_data.call_to_action) {
          const cta = oss.video_data.call_to_action.type;
          if (!CTA_TYPES.WEBSITE.includes(cta)) {
            return {
              valid: false,
              error: `CTA type "${cta}" is not allowed for WEBSITE destination. Allowed: ${CTA_TYPES.WEBSITE.join(", ")}`,
            };
          }
        }
        // Video ads don't need link_data validation
        break;
      }
      
      // For link ads (non-video), check link_data requirements
      // Check if CTA is a messaging type that doesn't require a link
      const ctaType = oss.link_data?.call_to_action?.type;
      const isMessagingCTA = ctaType === "WHATSAPP_MESSAGE" || ctaType === "SEND_MESSAGE" || ctaType === "MESSAGE_PAGE" || ctaType === "MESSAGE_US";
      
      // For messaging CTAs, link_data is optional and link is not required
      if (!isMessagingCTA) {
        // Non-messaging CTAs require link_data with link
        if (!oss.link_data || !oss.link_data.link) {
          return { valid: false, error: "link_data with link is required for WEBSITE destination ads" };
        }
      } else {
        // For messaging CTAs, link_data should exist but link is optional
        if (!oss.link_data) {
          return { valid: false, error: "link_data is required for messaging CTAs in WEBSITE destination ads" };
        }
      }
      
      // Validate CTA type
      if (oss.link_data && oss.link_data.call_to_action) {
        const cta = oss.link_data.call_to_action.type;
        if (!CTA_TYPES.WEBSITE.includes(cta)) {
          return {
            valid: false,
            error: `CTA type "${cta}" is not allowed for WEBSITE destination. Allowed: ${CTA_TYPES.WEBSITE.join(", ")}`,
          };
        }
      }
      // Ensure no app-related fields
      if (oss.link_data && oss.link_data.object_store_url) {
        return { valid: false, error: "object_store_url is not allowed for WEBSITE destination ads" };
      }
      break;

    case DESTINATION_TYPES.APP:
      // App ads require: app-related fields, no website URL
      if (!oss.link_data) {
        return { valid: false, error: "link_data is required for APP destination ads" };
      }
      // App ads should have object_store_url or app_id
      if (!oss.link_data.object_store_url && !oss.object_store_url) {
        return { valid: false, error: "object_store_url or app_id is required for APP destination ads" };
      }
      // Validate CTA type
      if (oss.link_data.call_to_action) {
        const ctaType = oss.link_data.call_to_action.type;
        if (!CTA_TYPES.APP.includes(ctaType)) {
          return {
            valid: false,
            error: `CTA type "${ctaType}" is not allowed for APP destination. Allowed: ${CTA_TYPES.APP.join(", ")}`,
          };
        }
      }
      // Website URL should not be present for app ads
      if (oss.link_data.link && !oss.link_data.link.includes("apps.apple.com") && !oss.link_data.link.includes("play.google.com")) {
        return { valid: false, error: "Regular website URLs are not allowed for APP destination ads. Use app store URLs or object_store_url." };
      }
      break;

    case DESTINATION_TYPES.LEAD_FORM:
      // Lead form ads require: lead form reference, no website URL
      if (!oss.lead_gen_form_id && !oss.page_id) {
        return { valid: false, error: "lead_gen_form_id or page_id is required for LEAD_FORM destination ads" };
      }
      // Validate CTA type
      if (oss.link_data && oss.link_data.call_to_action) {
        const ctaType = oss.link_data.call_to_action.type;
        if (!CTA_TYPES.LEAD_FORM.includes(ctaType)) {
          return {
            valid: false,
            error: `CTA type "${ctaType}" is not allowed for LEAD_FORM destination. Allowed: ${CTA_TYPES.LEAD_FORM.join(", ")}`,
          };
        }
      }
      // Website URL should not be present for lead form ads
      if (oss.link_data && oss.link_data.link) {
        return { valid: false, error: "link_data.link is not allowed for LEAD_FORM destination ads. Use lead_gen_form_id instead." };
      }
      break;

    default:
      return { valid: false, error: `Unknown destination_type: ${destinationType}` };
  }

  return { valid: true, error: null };
}

/**
 * Get destination types for a campaign objective from the new mapping
 * @param {string} campaignObjective - The campaign objective
 * @returns {string[]} Array of allowed destination types
 */
function getDestinationTypesForObjective(campaignObjective) {
  const mapping = CAMPAIGN_ADSET_MAPPING_V23[campaignObjective];
  if (mapping && mapping.destinationTypes) {
    // Map new destination types to our existing DESTINATION_TYPES
    const typeMapping = {
      "WEBSITE": DESTINATION_TYPES.WEBSITE,
      "APP_STORE": DESTINATION_TYPES.APP,
      "APP_DEEP_LINK": DESTINATION_TYPES.APP,
      "INSTANT_FORM": DESTINATION_TYPES.LEAD_FORM,
      "CALLS": DESTINATION_TYPES.LEAD_FORM,
      "ON_AD": DESTINATION_TYPES.WEBSITE,
      "MESSAGING_APPS": DESTINATION_TYPES.WEBSITE,
      "PHONE_CALL": DESTINATION_TYPES.WEBSITE,
      "INSTAGRAM_PROFILE": DESTINATION_TYPES.WEBSITE,
      "FACEBOOK_PAGE": DESTINATION_TYPES.WEBSITE,
      "APP": DESTINATION_TYPES.APP
    };
    
    // Convert new destination types to our standard types
    const mappedTypes = mapping.destinationTypes
      .map(type => typeMapping[type] || DESTINATION_TYPES.WEBSITE)
      .filter((value, index, self) => self.indexOf(value) === index); // Remove duplicates
    
    return mappedTypes.length > 0 ? mappedTypes : [DESTINATION_TYPES.WEBSITE];
  }
  
  // Fallback to legacy mapping for backward compatibility
  return OBJECTIVE_TO_DESTINATION[campaignObjective] || [DESTINATION_TYPES.WEBSITE];
}

/**
 * Get allowed destination types for a campaign objective
 * @param {string} campaignObjective - The campaign objective
 * @returns {string[]} Array of allowed destination types
 */
function getAllowedDestinations(campaignObjective) {
  return getDestinationTypesForObjective(campaignObjective);
}

/**
 * Get raw destination types from mapping (new format)
 * @param {string} campaignObjective - The campaign objective
 * @returns {string[]} Array of raw destination types from mapping
 */
function getRawDestinationTypes(campaignObjective) {
  const mapping = CAMPAIGN_ADSET_MAPPING_V23[campaignObjective];
  return mapping ? mapping.destinationTypes : [];
}

/**
 * Get allowed CTA types for a destination type
 * @param {string} destinationType - The destination type
 * @returns {string[]} Array of allowed CTA types
 */
function getAllowedCTAs(destinationType) {
  return CTA_TYPES[destinationType] || [];
}

/**
 * Get allowed optimization goals for a campaign objective
 * @param {string} campaignObjective - The campaign objective
 * @returns {string[]} Array of allowed optimization goals
 */
function getAllowedOptimizationGoals(campaignObjective) {
  const mapping = CAMPAIGN_ADSET_MAPPING_V23[campaignObjective];
  return mapping ? mapping.adsetOptimizationGoals : [];
}

/**
 * Get allowed CTAs for a campaign objective
 * @param {string} campaignObjective - The campaign objective
 * @returns {string[]} Array of allowed CTA types
 */
function getAllowedCTAsForObjective(campaignObjective) {
  const mapping = CAMPAIGN_ADSET_MAPPING_V23[campaignObjective];
  return mapping ? mapping.validCTAs : [];
}

/**
 * Get allowed object types for a campaign objective
 * @param {string} campaignObjective - The campaign objective
 * @returns {string[]} Array of allowed object types
 */
function getAllowedObjectTypes(campaignObjective) {
  const mapping = CAMPAIGN_ADSET_MAPPING_V23[campaignObjective];
  return mapping ? mapping.objectType : [];
}

/**
 * Validate that AdSet optimization_goal matches Campaign objective
 * @param {string} campaignObjective - The campaign objective
 * @param {string} optimizationGoal - The adset optimization_goal
 * @returns {Object} { valid: boolean, error: string|null }
 */
function validateOptimizationGoal(campaignObjective, optimizationGoal) {
  if (!campaignObjective) {
    return { valid: false, error: "Campaign objective is required" };
  }

  if (!optimizationGoal) {
    return { valid: false, error: "AdSet optimization_goal is required" };
  }

  const allowedGoals = getAllowedOptimizationGoals(campaignObjective);
  
  if (allowedGoals.length === 0) {
    return { valid: false, error: `No optimization goals defined for campaign objective: ${campaignObjective}` };
  }

  if (!allowedGoals.includes(optimizationGoal)) {
    return {
      valid: false,
      error: `Optimization goal "${optimizationGoal}" is not allowed for campaign objective "${campaignObjective}". Allowed: ${allowedGoals.join(", ")}`,
    };
  }

  return { valid: true, error: null };
}

/**
 * Validate that CTA type matches Campaign objective
 * @param {string} campaignObjective - The campaign objective
 * @param {string} ctaType - The CTA type
 * @returns {Object} { valid: boolean, error: string|null }
 */
function validateCTAForObjective(campaignObjective, ctaType) {
  if (!campaignObjective) {
    return { valid: false, error: "Campaign objective is required" };
  }

  if (!ctaType) {
    return { valid: true, error: null }; // CTA is optional
  }

  const allowedCTAs = getAllowedCTAsForObjective(campaignObjective);
  
  if (allowedCTAs.length === 0) {
    return { valid: false, error: `No CTA types defined for campaign objective: ${campaignObjective}` };
  }

  if (!allowedCTAs.includes(ctaType)) {
    return {
      valid: false,
      error: `CTA type "${ctaType}" is not allowed for campaign objective "${campaignObjective}". Allowed: ${allowedCTAs.join(", ")}`,
    };
  }

  return { valid: true, error: null };
}

module.exports = {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_OBJECTIVES_ARRAY,
  DESTINATION_TYPES,
  CTA_TYPES,
  OBJECTIVE_TO_DESTINATION,
  CAMPAIGN_ADSET_MAPPING_V23,
  validateCampaignToAdSet,
  validateAdSetToCreative,
  validateOptimizationGoal,
  validateCTAForObjective,
  getAllowedDestinations,
  getRawDestinationTypes,
  getAllowedCTAs,
  getAllowedOptimizationGoals,
  getAllowedCTAsForObjective,
  getAllowedObjectTypes,
};

