// File: controllers/meta/adset.controller.js
const axios = require("axios");
const {
  validateCampaignToAdSet,
  validateOptimizationGoal,
  DESTINATION_TYPES,
  getAllowedDestinations,
  getAllowedCTAs,
  getAllowedOptimizationGoals,
} = require("../../utils/metaValidation");
const { isTokenExpiredResponse, createTokenExpiredError } = require("../../utils/metaErrorHandler");

const FB_API_VERSION = process.env.FB_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;

function getAccessToken(req) {
  return req.header("x-fb-access-token") || process.env.FB_ACCESS_TOKEN || "";
}

async function fbRequest({ method, url, params, data, accessToken }) {
  console.log(`FB Request: ${method.toUpperCase()} ${url}`);
  console.log("Params:", {
    ...params,
    access_token: accessToken ? "REDACTED" : "N/A",
  });
  console.log("Data:", data);

  const res = await axios({
    method,
    url,
    params: { ...params, access_token: accessToken },
    data,
    validateStatus: () => true,
  });

  if (res.status >= 200 && res.status < 300) return res.data;

  const fbErr = res.data?.error || {
    message: res.statusText,
    code: res.status,
  };

  // Check if this is a token expiration error
  if (isTokenExpiredResponse(res)) {
    console.error("⚠️ Token expired error detected:", {
      code: fbErr.code,
      error_subcode: fbErr.error_subcode,
      message: fbErr.message,
    });
    throw createTokenExpiredError({ fb: fbErr, status: res.status });
  }

  // Log full error details
  console.error("Facebook API Error:", {
    status: res.status,
    error: fbErr,
    error_code: fbErr.code,
    error_type: fbErr.type,
    error_subcode: fbErr.error_subcode,
    error_user_title: fbErr.error_user_title,
    error_user_msg: fbErr.error_user_msg,
    response: res.data,
  });

  // Create detailed error message
  let errorMessage = fbErr.message || "Facebook API error";
  if (fbErr.error_user_msg) {
    errorMessage = `${errorMessage} (${fbErr.error_user_msg})`;
  }
  if (fbErr.error_subcode) {
    errorMessage = `${errorMessage} [Subcode: ${fbErr.error_subcode}]`;
  }

  const e = new Error(errorMessage);
  e.status = res.status;
  e.fb = fbErr;
  throw e;
}

function requireFields(obj, fields = []) {
  const missing = fields.filter((f) => obj[f] == null || obj[f] === "");
  if (missing.length) {
    const e = new Error(`Missing required fields: ${missing.join(", ")}`);
    e.status = 400;
    throw e;
  }
}

// Helper function to handle errors and check for token expiration
function handleError(err, res, next) {
  // Check if this is a token expiration error
  if (err.isTokenExpired || (err.fb && err.fb.code === 190 && err.fb.error_subcode === 463)) {
    console.error("⚠️ Token expired - returning disconnect signal");
    return res.status(401).json({
      success: false,
      error: "Facebook access token has expired. Please reconnect your account.",
      code: "TOKEN_EXPIRED",
      tokenExpired: true,
      fb: err.fb || err.error,
    });
  }
  
  // Handle other errors
  const status = err.status || 500;
  const message = err.message || "An error occurred";
  
  return res.status(status).json({
    success: false,
    error: message,
    fb: err.fb,
    details: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
}

// Create AdSet
exports.createAdSet = async (req, res, next) => {
  const accessToken = getAccessToken(req);

  try {
    if (!accessToken) {
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    }

    const {
      campaignId,
      adAccountId, // REQUIRED for reliable AdSet creation
      name,
      optimizationGoal,
      billingEvent,
      bidAmount,
      bidStrategy, // NEW: bid_strategy parameter
      bidConstraints, // NEW: bid_constraints for ROAS_GOAL
      dailyBudget,
      lifetimeBudget,
      targeting,
      status = "PAUSED",
      startTime,
      endTime,
      promotedObject: promotedObjectCamelCase, // Frontend sends promotedObject (camelCase) with pageId
      destinationType, // NEW: destination type (WEBSITE, APP, LEAD_FORM)
      autoFixBudget = false, // NEW: auto-fix budget flag
      pixelId, // For OFFSITE_CONVERSIONS - Facebook Pixel ID
      conversionEvent, // For OFFSITE_CONVERSIONS - conversion event name (e.g., PURCHASE, ADD_TO_CART)
      whatsappNumber, // For CONVERSATIONS - WhatsApp Business number
      pageId: initialPageId, // Facebook Page ID (camelCase) - for backward compatibility
      page_id: initialPageIdSnakeCase, // Facebook Page ID (snake_case) - preferred format
      promoted_object, // Can be provided as an object with pageId (camelCase) or page_id (snake_case)
    } = req.body || {};

    // Use let variables so we can modify them
    // Prefer page_id (snake_case) over pageId (camelCase)
    let pageId = initialPageIdSnakeCase || initialPageId;
    let promotedObject = null;

    // Handle promotedObject (camelCase) from frontend - extract pageId
    // Frontend format: { "promotedObject": { "pageId": "872112295975806" } }
    if (
      promotedObjectCamelCase &&
      typeof promotedObjectCamelCase === "object" &&
      !Array.isArray(promotedObjectCamelCase)
    ) {
      if (promotedObjectCamelCase.pageId && !pageId) {
        pageId = promotedObjectCamelCase.pageId;
        console.log(
          "✅ Extracted pageId from promotedObject.pageId (frontend format):",
          pageId
        );
      }
    }

    // Log page_id extraction for debugging
    if (pageId) {
      console.log("✅ page_id/pageId received from frontend:", pageId);
    } else {
      console.log("ℹ️ No page_id/pageId provided in request body");
    }

    // Handle promoted_object if provided as an object in request body
    // Support both camelCase (pageId) and snake_case (page_id) formats
    if (
      promoted_object &&
      typeof promoted_object === "object" &&
      !Array.isArray(promoted_object)
    ) {
      // Extract pageId from promoted_object if present (camelCase or snake_case)
      if (promoted_object.pageId && !pageId) {
        pageId = promoted_object.pageId;
        console.log("ℹ️ Extracted pageId from promoted_object.pageId:", pageId);
      } else if (promoted_object.page_id && !pageId) {
        pageId = promoted_object.page_id;
        console.log(
          "ℹ️ Extracted pageId from promoted_object.page_id:",
          pageId
        );
      }

      // Merge promoted_object with existing promotedObject if both exist
      // IMPORTANT: Remove pageId (camelCase) from promotedObject - Meta API only accepts page_id (snake_case)
      // We'll use the pageId variable separately, not from promotedObject
      if (promotedObject && typeof promotedObject === "object") {
        const { pageId: _, ...promotedObjectWithoutPageId } = promotedObject;
        const {
          pageId: __,
          page_id: ___,
          ...promotedObjectInputWithoutPageId
        } = promoted_object;
        promotedObject = {
          ...promotedObjectWithoutPageId,
          ...promotedObjectInputWithoutPageId,
        };
      } else if (!promotedObject) {
        const {
          pageId: _,
          page_id: __,
          ...promotedObjectInputWithoutPageId
        } = promoted_object;
        promotedObject = { ...promotedObjectInputWithoutPageId };
      }
    }

    // Minimum daily budget constant (in paise, since Meta uses cents/paise)
    // ₹225 = 22500 paise (×100)
    const MIN_DAILY_BUDGET = 22500;

    // Universal allowed billing events for new ad accounts
    // New accounts only support: IMPRESSIONS, LINK_CLICKS, CLICKS
    // They do NOT support: VALUE, THRUPLAY, LANDING_PAGE_VIEWS, POST_ENGAGEMENT,
    // APP_INSTALLS, OFFSITE_CONVERSIONS, IMPRESSION_DEVICE, or any event tied to ROAS_GOAL
    const ALLOWED_BILLING_EVENTS = ["IMPRESSIONS", "CLICKS", "LINK_CLICKS"];

    // Unsupported billing events that should never be sent to Meta API
    const UNSUPPORTED_BILLING_EVENTS = [
      "VALUE",
      "THRUPLAY",
      "LANDING_PAGE_VIEWS",
      "POST_ENGAGEMENT",
      "APP_INSTALLS",
      "OFFSITE_CONVERSIONS",
      "IMPRESSION_DEVICE",
    ];

    // Check if account is new (from config or request body)
    // Default to true for safety - new accounts can only use IMPRESSIONS billing
    // Set FB_NEW_ACCOUNT=false in .env if you're sure the account is not new
    // Set FB_FORCE_IMPRESSIONS=true to always use IMPRESSIONS (safest option)
    const isNewAccount =
      req.body?.newAccount !== false &&
      (req.body?.newAccount === true ||
        process.env.FB_NEW_ACCOUNT === "true" ||
        process.env.FB_NEW_ACCOUNT !== "false");
    const forceImpressions =
      process.env.FB_FORCE_IMPRESSIONS === "true" || isNewAccount;

    console.log("📥 AdSet creation request received:");
    console.log("  - campaignId:", campaignId);
    console.log("  - adAccountId:", adAccountId);
    console.log("  - name:", name);
    console.log(
      "  - bidStrategy:",
      bidStrategy || "not provided (will use default)"
    );
    console.log("  - bidAmount:", bidAmount);
    console.log("  - bidConstraints:", bidConstraints);
    console.log("  - billingEvent:", billingEvent);
    console.log("  - isNewAccount:", isNewAccount);

    requireFields({ campaignId, name, optimizationGoal, billingEvent }, [
      "campaignId",
      "name",
      "optimizationGoal",
      "billingEvent",
    ]);

    // Trim whitespace from optimizationGoal and create a new variable
    let finalOptimizationGoal =
      typeof optimizationGoal === "string"
        ? optimizationGoal.trim()
        : optimizationGoal;

    // Map common campaign objective values to valid optimization goals (v23.0)
    // These are campaign objectives that users might confuse with optimization goals
    const OPTIMIZATION_GOAL_MAPPING = {
      OUTCOME_AWARENESS: "REACH",
      OUTCOME_TRAFFIC: "LINK_CLICKS",
      OUTCOME_ENGAGEMENT: "POST_ENGAGEMENT",
      OUTCOME_LEADS: "LEAD_GENERATION",
      OUTCOME_SALES: "VALUE",
      OUTCOME_APP_PROMOTION: "APP_INSTALLS",
    };

    // Apply mapping if needed
    if (OPTIMIZATION_GOAL_MAPPING[finalOptimizationGoal]) {
      const mappedValue = OPTIMIZATION_GOAL_MAPPING[finalOptimizationGoal];
      console.log(
        `⚠️ Mapped optimizationGoal from "${finalOptimizationGoal}" to "${mappedValue}"`
      );
      finalOptimizationGoal = mappedValue;
    }

    // Validate optimization_goal against Facebook's allowed values
    const VALID_OPTIMIZATION_GOALS = [
      "NONE",
      "APP_INSTALLS",
      "AD_RECALL_LIFT",
      "ENGAGED_USERS",
      "EVENT_RESPONSES",
      "IMPRESSIONS",
      "LEAD_GENERATION",
      "QUALITY_LEAD",
      "LINK_CLICKS",
      "OFFSITE_CONVERSIONS",
      "PAGE_LIKES",
      "POST_ENGAGEMENT",
      "QUALITY_CALL",
      "REACH",
      "LANDING_PAGE_VIEWS",
      "VISIT_INSTAGRAM_PROFILE",
      "VALUE",
      "THRUPLAY",
      "DERIVED_EVENTS",
      "APP_INSTALLS_AND_OFFSITE_CONVERSIONS",
      "CONVERSATIONS",
      "IN_APP_VALUE",
      "MESSAGING_PURCHASE_CONVERSION",
      "SUBSCRIBERS",
      "REMINDERS_SET",
      "MEANINGFUL_CALL_ATTEMPT",
      "PROFILE_VISIT",
      "PROFILE_AND_PAGE_ENGAGEMENT",
      "ADVERTISER_SILOED_VALUE",
      "AUTOMATIC_OBJECTIVE",
      "MESSAGING_APPOINTMENT_CONVERSION",
    ];

    if (!VALID_OPTIMIZATION_GOALS.includes(finalOptimizationGoal)) {
      throw Object.assign(
        new Error(
          `Invalid optimizationGoal: "${finalOptimizationGoal}". ` +
            `Must be one of: ${VALID_OPTIMIZATION_GOALS.join(", ")}`
        ),
        { status: 400 }
      );
    }

    if (!dailyBudget && !lifetimeBudget) {
      throw Object.assign(
        new Error("Either dailyBudget or lifetimeBudget is required"),
        { status: 400 }
      );
    }

    // Validate and convert budgets to integers (Meta requires integers)
    let dailyBudgetValue = null;
    let lifetimeBudgetValue = null;

    if (dailyBudget) {
      // Convert to integer (handle string, float, etc.)
      dailyBudgetValue = Math.round(parseFloat(dailyBudget));

      if (isNaN(dailyBudgetValue) || dailyBudgetValue <= 0) {
        throw Object.assign(
          new Error("Daily budget must be a valid positive number"),
          { status: 400 }
        );
      }

      // Validate minimum budget
      if (dailyBudgetValue < MIN_DAILY_BUDGET) {
        const budgetInRupees = (dailyBudgetValue / 100).toFixed(2);
        const minInRupees = (MIN_DAILY_BUDGET / 100).toFixed(2);

        if (autoFixBudget) {
          // Auto-fix: set to minimum
          dailyBudgetValue = MIN_DAILY_BUDGET;
          console.warn(
            `⚠️ Auto-corrected daily budget to minimum allowed by Meta: ₹${minInRupees}`
          );
        } else {
          throw Object.assign(
            new Error(
              `Daily budget must be at least ₹${minInRupees}. Provided: ₹${budgetInRupees}`
            ),
            { status: 400 }
          );
        }
      }
    }

    if (lifetimeBudget) {
      // Convert to integer (handle string, float, etc.)
      lifetimeBudgetValue = Math.round(parseFloat(lifetimeBudget));

      if (isNaN(lifetimeBudgetValue) || lifetimeBudgetValue <= 0) {
        throw Object.assign(
          new Error("Lifetime budget must be a valid positive number"),
          { status: 400 }
        );
      }

      // Validate minimum budget
      if (lifetimeBudgetValue < MIN_DAILY_BUDGET) {
        const budgetInRupees = (lifetimeBudgetValue / 100).toFixed(2);
        const minInRupees = (MIN_DAILY_BUDGET / 100).toFixed(2);

        if (autoFixBudget) {
          // Auto-fix: set to minimum
          lifetimeBudgetValue = MIN_DAILY_BUDGET;
          console.warn(
            `⚠️ Auto-corrected lifetime budget to minimum allowed by Meta: ₹${minInRupees}`
          );
        } else {
          throw Object.assign(
            new Error(
              `Lifetime budget must be at least ₹${minInRupees}. Provided: ₹${budgetInRupees}`
            ),
            { status: 400 }
          );
        }
      }
    }

    // Validate campaign ID format
    if (!campaignId || typeof campaignId !== "string") {
      throw Object.assign(new Error("Invalid campaign ID provided"), {
        status: 400,
      });
    }

    // Validate and auto-correct billing_event for new accounts
    let finalBillingEvent = billingEvent;
    let billingEventChanged = false;

    // Rule 1: Always check if billing_event is in allowed list (universal check)
    if (!ALLOWED_BILLING_EVENTS.includes(finalBillingEvent)) {
      console.warn(
        `⚠️ Billing event '${finalBillingEvent}' is not in allowed list. Replacing with IMPRESSIONS.`
      );
      console.warn(
        `   Allowed billing events: ${ALLOWED_BILLING_EVENTS.join(", ")}`
      );
      finalBillingEvent = "IMPRESSIONS";
      billingEventChanged = true;
    }

    // Rule 2: Block unsupported billing events explicitly
    if (UNSUPPORTED_BILLING_EVENTS.includes(finalBillingEvent)) {
      console.warn(
        `⚠️ Billing event '${finalBillingEvent}' is not supported for new ad accounts. Replacing with IMPRESSIONS.`
      );
      finalBillingEvent = "IMPRESSIONS";
      billingEventChanged = true;
    }

    // Rule 3: If account is new, ALWAYS use IMPRESSIONS (new accounts only support IMPRESSIONS)
    // This is critical - new accounts cannot use LINK_CLICKS or CLICKS billing
    if (isNewAccount) {
      if (finalBillingEvent !== "IMPRESSIONS") {
        console.warn(
          `⚠️ New account detected - FORCING billing_event to IMPRESSIONS (was: ${finalBillingEvent})`
        );
        console.warn(
          `   New accounts only support IMPRESSIONS billing. LINK_CLICKS and CLICKS are not available.`
        );
        finalBillingEvent = "IMPRESSIONS";
        billingEventChanged = true;
      }
    }

    const payload = {
      name,
      optimization_goal: finalOptimizationGoal,
      billing_event: finalBillingEvent,
      status,
      campaign_id: campaignId,
    };

    console.log(`✅ Final billing_event set to: ${finalBillingEvent}`);

    // Set validated budgets (already converted to integers and validated above)
    if (dailyBudgetValue !== null) {
      payload.daily_budget = dailyBudgetValue;
      console.log(
        `💰 Daily budget set to: ₹${(dailyBudgetValue / 100).toFixed(
          2
        )} (${dailyBudgetValue} paise)`
      );
    }
    if (lifetimeBudgetValue !== null) {
      payload.lifetime_budget = lifetimeBudgetValue;
      console.log(
        `💰 Lifetime budget set to: ₹${(lifetimeBudgetValue / 100).toFixed(
          2
        )} (${lifetimeBudgetValue} paise)`
      );
    }
    if (startTime) payload.start_time = startTime;
    if (endTime) payload.end_time = endTime;

    // Handle bid strategy and bid amount/constraints
    // Map user-friendly values to Meta API values
    const bidStrategyMapping = {
      LOWEST_COST: "LOWEST_COST_WITHOUT_CAP",
      BID_CAP: "LOWEST_COST_WITH_BID_CAP",
      COST_CAP: "COST_CAP",
      ROAS_GOAL: "LOWEST_COST_WITH_MIN_ROAS",
    };

    // Default to LOWEST_COST if not specified
    const userBidStrategy = bidStrategy || "LOWEST_COST";

    // Map to Meta API value
    let finalBidStrategy = bidStrategyMapping[userBidStrategy];

    // If user provided a value that's already a Meta API value, use it directly
    const validMetaBidStrategies = [
      "LOWEST_COST_WITHOUT_CAP",
      "LOWEST_COST_WITH_BID_CAP",
      "COST_CAP",
      "LOWEST_COST_WITH_MIN_ROAS",
    ];

    if (!finalBidStrategy) {
      // Check if user provided a valid Meta API value directly
      if (validMetaBidStrategies.includes(userBidStrategy)) {
        finalBidStrategy = userBidStrategy;
      } else {
        throw Object.assign(
          new Error(
            `Invalid bidStrategy: ${userBidStrategy}. Valid values: LOWEST_COST, BID_CAP, COST_CAP, ROAS_GOAL (or Meta API values: LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP, LOWEST_COST_WITH_MIN_ROAS)`
          ),
          { status: 400 }
        );
      }
    }

    // Validate final bid_strategy is one of the 4 valid Meta API values
    if (!validMetaBidStrategies.includes(finalBidStrategy)) {
      throw Object.assign(
        new Error(
          `Invalid bid_strategy: ${finalBidStrategy}. Must be one of: LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP, LOWEST_COST_WITH_MIN_ROAS`
        ),
        { status: 400 }
      );
    }

    payload.bid_strategy = finalBidStrategy;

    console.log("💰 Bid Strategy - User provided:", userBidStrategy);
    console.log("💰 Bid Strategy - Mapped to Meta API:", finalBidStrategy);

    // Apply bid strategy rules based on final Meta API value
    switch (finalBidStrategy) {
      case "LOWEST_COST_WITHOUT_CAP":
        // Remove bid_amount and bid_constraints
        // Don't include them in payload
        console.log(
          "✅ Using LOWEST_COST_WITHOUT_CAP - no bid_amount or bid_constraints needed"
        );
        break;

      case "LOWEST_COST_WITH_BID_CAP":
        // Require bid_amount, remove bid_constraints
        if (!bidAmount) {
          throw Object.assign(
            new Error(
              "bidAmount is required when bidStrategy is LOWEST_COST_WITH_BID_CAP (or BID_CAP)"
            ),
            { status: 400 }
          );
        }
        payload.bid_amount = parseInt(bidAmount);
        console.log(
          "✅ Using LOWEST_COST_WITH_BID_CAP - bid_amount:",
          payload.bid_amount
        );
        break;

      case "COST_CAP":
        // Require bid_amount, remove bid_constraints
        if (!bidAmount) {
          throw Object.assign(
            new Error("bidAmount is required when bidStrategy is COST_CAP"),
            { status: 400 }
          );
        }
        payload.bid_amount = parseInt(bidAmount);
        console.log("✅ Using COST_CAP - bid_amount:", payload.bid_amount);
        break;

      case "LOWEST_COST_WITH_MIN_ROAS":
        // Require optimization_goal = "VALUE" and bid_constraints with roas_average_floor
        if (finalOptimizationGoal !== "VALUE") {
          throw Object.assign(
            new Error(
              'optimizationGoal must be "VALUE" when bidStrategy is LOWEST_COST_WITH_MIN_ROAS (or ROAS_GOAL)'
            ),
            { status: 400 }
          );
        }
        if (!bidConstraints || !bidConstraints.roas_average_floor) {
          throw Object.assign(
            new Error(
              "bidConstraints with roas_average_floor is required when bidStrategy is LOWEST_COST_WITH_MIN_ROAS (or ROAS_GOAL)"
            ),
            { status: 400 }
          );
        }
        // Set optimization_goal to VALUE (already validated above)
        payload.optimization_goal = "VALUE";
        // Set bid_constraints as JSON string
        payload.bid_constraints = JSON.stringify({
          roas_average_floor: parseFloat(bidConstraints.roas_average_floor),
        });
        // ROAS RULE: Force billing_event to IMPRESSIONS (never VALUE)
        if (
          payload.billing_event === "VALUE" ||
          !ALLOWED_BILLING_EVENTS.includes(payload.billing_event)
        ) {
          console.warn(
            `⚠️ LOWEST_COST_WITH_MIN_ROAS: Forcing billing_event to IMPRESSIONS (was: ${payload.billing_event})`
          );
          payload.billing_event = "IMPRESSIONS";
          billingEventChanged = true;
        }
        console.log(
          "✅ Using LOWEST_COST_WITH_MIN_ROAS - bid_constraints:",
          payload.bid_constraints
        );
        break;

      default:
        // This should never happen due to validation above, but just in case
        throw Object.assign(
          new Error(
            `Invalid bid_strategy: ${finalBidStrategy}. Must be one of: LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP, LOWEST_COST_WITH_MIN_ROAS`
          ),
          { status: 400 }
        );
    }

    // Targeting must be a JSON string for Facebook API
    if (targeting) {
      let targetingObj = targeting;
      if (typeof targeting === "string") {
        try {
          targetingObj = JSON.parse(targeting);
        } catch (e) {
          throw Object.assign(
            new Error("Invalid targeting format. Must be valid JSON."),
            { status: 400 }
          );
        }
      }

      // Validate targeting structure
      // Countries are required UNLESS custom_locations are provided
      const hasCountries =
        targetingObj.geo_locations?.countries &&
        Array.isArray(targetingObj.geo_locations.countries) &&
        targetingObj.geo_locations.countries.length > 0;
      const hasCustomLocations =
        targetingObj.geo_locations?.custom_locations &&
        Array.isArray(targetingObj.geo_locations.custom_locations) &&
        targetingObj.geo_locations.custom_locations.length > 0;

      if (!targetingObj.geo_locations) {
        throw Object.assign(
          new Error(
            "Targeting must include geo_locations with at least one of: countries, custom_locations, regions, or cities"
          ),
          { status: 400 }
        );
      }

      if (
        !hasCountries &&
        !hasCustomLocations &&
        (!targetingObj.geo_locations.regions ||
          targetingObj.geo_locations.regions.length === 0) &&
        (!targetingObj.geo_locations.cities ||
          targetingObj.geo_locations.cities.length === 0)
      ) {
        throw Object.assign(
          new Error(
            "Targeting must include at least one of: countries, custom_locations, regions, or cities in geo_locations"
          ),
          { status: 400 }
        );
      }

      // Ensure age_min and age_max are valid (Facebook allows 13-65)
      if (targetingObj.age_min !== undefined) {
        const ageMin = parseInt(targetingObj.age_min);
        if (isNaN(ageMin) || ageMin < 13 || ageMin > 65) {
          throw Object.assign(new Error("age_min must be between 13 and 65"), {
            status: 400,
          });
        }
        targetingObj.age_min = ageMin;
      }
      if (targetingObj.age_max !== undefined) {
        const ageMax = parseInt(targetingObj.age_max);
        if (isNaN(ageMax) || ageMax < 13 || ageMax > 65) {
          throw Object.assign(new Error("age_max must be between 13 and 65"), {
            status: 400,
          });
        }
        targetingObj.age_max = ageMax;
      }
      if (
        targetingObj.age_min &&
        targetingObj.age_max &&
        targetingObj.age_min > targetingObj.age_max
      ) {
        throw Object.assign(
          new Error("age_min cannot be greater than age_max"),
          { status: 400 }
        );
      }

      // Remove empty interests array if present (Facebook doesn't like empty arrays in targeting)
      if (
        targetingObj.interests &&
        Array.isArray(targetingObj.interests) &&
        targetingObj.interests.length === 0
      ) {
        delete targetingObj.interests;
      }

      // Remove empty work_positions array if present
      if (
        targetingObj.work_positions &&
        Array.isArray(targetingObj.work_positions) &&
        targetingObj.work_positions.length === 0
      ) {
        delete targetingObj.work_positions;
      }

      // Remove empty work_employers array if present
      if (
        targetingObj.work_employers &&
        Array.isArray(targetingObj.work_employers) &&
        targetingObj.work_employers.length === 0
      ) {
        delete targetingObj.work_employers;
      }

      // Ensure geo_locations structure is correct
      if (!targetingObj.geo_locations) {
        targetingObj.geo_locations = {};
      }

      // Validate countries if provided (optional if custom_locations are provided)
      if (targetingObj.geo_locations.countries) {
        if (!Array.isArray(targetingObj.geo_locations.countries)) {
          throw Object.assign(
            new Error("geo_locations.countries must be an array"),
            { status: 400 }
          );
        }

        // Log received countries for debugging
        console.log(
          "📋 Received countries:",
          targetingObj.geo_locations.countries
        );
        console.log(
          "📋 Countries type:",
          typeof targetingObj.geo_locations.countries[0]
        );
        console.log(
          "📋 Countries value:",
          JSON.stringify(targetingObj.geo_locations.countries)
        );

        // Filter and validate country codes - handle both string and number types
        const validCountries = targetingObj.geo_locations.countries
          .map((country) => {
            // Convert to string if it's a number or other type
            if (typeof country !== "string") {
              country = String(country);
            }
            return country.trim().toUpperCase();
          })
          .filter(
            (country) =>
              country && country.length === 2 && /^[A-Z]{2}$/.test(country)
          );

        console.log("✅ Validated countries:", validCountries);

        if (
          validCountries.length === 0 &&
          targetingObj.geo_locations.countries.length > 0
        ) {
          console.error(
            "❌ No valid countries found. Received:",
            targetingObj.geo_locations.countries
          );
          throw Object.assign(
            new Error(
              `Invalid country codes. All country codes must be valid 2-letter ISO codes. Received: ${JSON.stringify(
                targetingObj.geo_locations.countries
              )}`
            ),
            { status: 400 }
          );
        }

        // Update with validated countries (or remove if empty)
        if (validCountries.length > 0) {
          targetingObj.geo_locations.countries = validCountries;
        } else {
          delete targetingObj.geo_locations.countries;
        }
      }

      // Validate custom_locations if provided
      if (targetingObj.geo_locations.custom_locations) {
        if (!Array.isArray(targetingObj.geo_locations.custom_locations)) {
          throw Object.assign(
            new Error("geo_locations.custom_locations must be an array"),
            { status: 400 }
          );
        }

        // Validate each custom location
        targetingObj.geo_locations.custom_locations =
          targetingObj.geo_locations.custom_locations.map((loc, index) => {
            if (
              typeof loc.latitude !== "number" &&
              typeof loc.latitude !== "string"
            ) {
              throw Object.assign(
                new Error(
                  `custom_locations[${index}]: latitude must be a number`
                ),
                { status: 400 }
              );
            }
            if (
              typeof loc.longitude !== "number" &&
              typeof loc.longitude !== "string"
            ) {
              throw Object.assign(
                new Error(
                  `custom_locations[${index}]: longitude must be a number`
                ),
                { status: 400 }
              );
            }
            const lat = parseFloat(loc.latitude);
            const lng = parseFloat(loc.longitude);

            if (isNaN(lat) || lat < -90 || lat > 90) {
              throw Object.assign(
                new Error(
                  `custom_locations[${index}]: latitude must be between -90 and 90`
                ),
                { status: 400 }
              );
            }
            if (isNaN(lng) || lng < -180 || lng > 180) {
              throw Object.assign(
                new Error(
                  `custom_locations[${index}]: longitude must be between -180 and 180`
                ),
                { status: 400 }
              );
            }
            return {
              latitude: lat,
              longitude: lng,
              radius: parseInt(loc.radius) || 10,
              distance_unit: loc.distance_unit || "kilometer",
            };
          });

        console.log(
          "✅ Validated custom_locations:",
          targetingObj.geo_locations.custom_locations
        );
      }

      // Add targeting_automation with advantage_audience flag (required by Meta API)
      // advantage_audience: 1 = enabled, 0 = disabled
      // Default to 0 (disabled) for more control, but can be set to 1 to let Meta optimize
      if (!targetingObj.targeting_automation) {
        targetingObj.targeting_automation = {};
      }
      // Set advantage_audience flag (required by Meta)
      // Use value from request body if provided, otherwise default to 0 (disabled)
      const advantageAudience =
        req.body?.advantageAudience !== undefined
          ? req.body.advantageAudience
            ? 1
            : 0
          : 0; // Default to disabled (0)

      targetingObj.targeting_automation.advantage_audience = advantageAudience;

      console.log(
        "📊 Targeting automation - advantage_audience:",
        advantageAudience
      );

      // Convert targeting to JSON string for Facebook API
      payload.targeting = JSON.stringify(targetingObj);
    } else {
      // Targeting is required for AdSet
      throw Object.assign(
        new Error("Targeting is required for AdSet creation"),
        { status: 400 }
      );
    }

    // Validate promoted_object for APP_INSTALLS and APP_ENGAGEMENT optimization goals
    if (
      finalOptimizationGoal === "APP_INSTALLS" ||
      finalOptimizationGoal === "APP_ENGAGEMENT"
    ) {
      if (!promotedObject) {
        throw Object.assign(
          new Error(
            "promoted_object with app_id (application_id) is required for APP_INSTALLS and APP_ENGAGEMENT optimization goals. Please provide app_id in promoted_object."
          ),
          { status: 400 }
        );
      }

      // Meta API requires both application_id (app_id) AND object_store_url for app installs
      if (!promotedObject.app_id) {
        throw Object.assign(
          new Error(
            "promoted_object must include app_id (application_id) for APP_INSTALLS and APP_ENGAGEMENT optimization goals. Please provide the Facebook App ID."
          ),
          { status: 400 }
        );
      }

      // Meta API also requires object_store_url for app installs
      if (
        !promotedObject.object_store_url ||
        !promotedObject.object_store_url.trim()
      ) {
        throw Object.assign(
          new Error(
            "promoted_object must include object_store_url for APP_INSTALLS and APP_ENGAGEMENT optimization goals. Please provide the App Store URL (Apple App Store or Google Play Store)."
          ),
          { status: 400 }
        );
      }

      console.log(
        "ℹ️ Both app_id and object_store_url provided for app optimization"
      );

      console.log(
        "✅ Validated promoted_object for APP optimization goal:",
        JSON.stringify(promotedObject, null, 2)
      );
    }

    // Validate pixel_id and conversion_event for OFFSITE_CONVERSIONS
    if (finalOptimizationGoal === "OFFSITE_CONVERSIONS") {
      if (!pixelId) {
        throw Object.assign(
          new Error(
            "pixel_id is required for OFFSITE_CONVERSIONS optimization goal. Please provide your Facebook Pixel ID."
          ),
          { status: 400 }
        );
      }

      if (!conversionEvent) {
        throw Object.assign(
          new Error(
            "conversion_event is required for OFFSITE_CONVERSIONS optimization goal. Please provide a conversion event (e.g., PURCHASE, ADD_TO_CART, LEAD, COMPLETE_REGISTRATION)."
          ),
          { status: 400 }
        );
      }

      console.log(
        "✅ Validated pixel_id and conversion_event for OFFSITE_CONVERSIONS:"
      );
      console.log("  - pixel_id:", pixelId);
      console.log("  - conversion_event:", conversionEvent);
    }

    // Format promoted_object for Meta API
    // Meta API expects 'application_id' not 'app_id'
    // Meta API requires BOTH application_id AND object_store_url for app installs
    // For OFFSITE_CONVERSIONS, promoted_object needs pixel_id and custom_event_type
    // For WEBSITE destination, promoted_object can include page_id
    // According to Meta API v23 documentation:
    // - promoted_object should be a JSON string
    // - For APP_INSTALLS/APP_ENGAGEMENT: { "application_id": "...", "object_store_url": "..." }
    // - For OFFSITE_CONVERSIONS: { "pixel_id": "...", "custom_event_type": "..." }
    // - For WEBSITE: { "page_id": "..." } (optional but recommended)
    if (
      promotedObject ||
      finalOptimizationGoal === "OFFSITE_CONVERSIONS" ||
      pageId
    ) {
      const metaPromotedObject = {};

      // Handle app installs (APP_INSTALLS, APP_ENGAGEMENT)
      if (
        finalOptimizationGoal === "APP_INSTALLS" ||
        finalOptimizationGoal === "APP_ENGAGEMENT"
      ) {
        if (promotedObject && promotedObject.app_id) {
          // Convert app_id to application_id for Meta API (REQUIRED)
          metaPromotedObject.application_id = String(
            promotedObject.app_id
          ).trim();
        }

        if (promotedObject && promotedObject.object_store_url) {
          // object_store_url is REQUIRED for app installs
          // Meta validates that object_store_url matches the application_id
          // If they don't match, Meta will reject the request with error 1885093
          metaPromotedObject.object_store_url = String(
            promotedObject.object_store_url
          ).trim();
          console.log(
            "ℹ️ Including object_store_url in promoted_object. Meta will validate it matches the application_id."
          );
        }
      }

      // Handle OFFSITE_CONVERSIONS - add pixel_id and custom_event_type
      // Meta API v23 requires both pixel_id and custom_event_type in promoted_object
      if (finalOptimizationGoal === "OFFSITE_CONVERSIONS") {
        if (pixelId) {
          metaPromotedObject.pixel_id = String(pixelId).trim();
        }
        if (conversionEvent) {
          // Meta API expects custom_event_type (not conversion_event)
          metaPromotedObject.custom_event_type =
            String(conversionEvent).toUpperCase();
        }
        console.log(
          "ℹ️ Adding pixel_id and custom_event_type for OFFSITE_CONVERSIONS"
        );
      }

      // Add page_id if provided (for WEBSITE destination ads)
      // page_id in promoted_object helps Meta understand which page the ads are promoting
      // IMPORTANT: Use page_id (snake_case), NOT pageId (camelCase) - Meta API rejects camelCase
      // Format: { page_id: page_id } in promoted_object
      if (pageId && pageId.trim()) {
        metaPromotedObject.page_id = String(pageId).trim();
        console.log("ℹ️ Including page_id in promoted_object:", pageId);
      }

      // Handle CONVERSATIONS or WHATSAPP destination type - add whatsapp_number
      // Meta API requires whatsapp_number in promoted_object for CONVERSATIONS optimization goal or WHATSAPP destination type
      if (finalOptimizationGoal === "CONVERSATIONS" || (destinationType && destinationType.toUpperCase() === "WHATSAPP")) {
        if (whatsappNumber && whatsappNumber.trim()) {
          metaPromotedObject.whatsapp_number = String(whatsappNumber).trim();
          console.log("📱 Adding whatsapp_number for CONVERSATIONS/WHATSAPP:", whatsappNumber);
        }
      }

      // Only add promoted_object if it has at least one field
      // Ensure we never include pageId (camelCase) - only page_id (snake_case)
      if (Object.keys(metaPromotedObject).length > 0) {
        // Meta API requires promoted_object as a JSON string
        // Double-check: ensure no camelCase keys are present (Meta API only accepts snake_case)
        // CRITICAL: Meta API rejects pageId (camelCase) - must use page_id (snake_case)
        const finalPromotedObject = {};
        const validKeys = [
          "page_id",
          "application_id",
          "object_store_url",
          "pixel_id",
          "custom_event_type",
          "whatsapp_number",
        ];

        Object.keys(metaPromotedObject).forEach((key) => {
          // Only include valid Meta API keys (snake_case)
          // Explicitly reject pageId (camelCase) and any other invalid keys
          if (key === "pageId") {
            console.warn(
              `⚠️ WARNING: Found pageId (camelCase) in metaPromotedObject - IGNORING (Meta API rejects this)`
            );
            return; // Skip pageId - it's invalid
          }
          if (validKeys.includes(key)) {
            finalPromotedObject[key] = metaPromotedObject[key];
          } else {
            console.warn(
              `⚠️ WARNING: Found invalid key '${key}' in metaPromotedObject - IGNORING (not a valid Meta API key)`
            );
          }
        });

        // Final safety check: ensure pageId is NOT in the final object
        if (finalPromotedObject.pageId) {
          console.error(
            `❌ CRITICAL ERROR: pageId found in finalPromotedObject! Removing it.`
          );
          delete finalPromotedObject.pageId;
        }

        payload.promoted_object = JSON.stringify(finalPromotedObject);
        console.log(
          "📤 Formatted promoted_object for Meta API (snake_case only):",
          JSON.stringify(finalPromotedObject, null, 2)
        );

        // Final verification: parse the stringified object to ensure no pageId
        try {
          const verify = JSON.parse(payload.promoted_object);
          if (verify.pageId) {
            console.error(
              `❌ CRITICAL: pageId still present after stringification! Removing it.`
            );
            delete verify.pageId;
            payload.promoted_object = JSON.stringify(verify);
          }
        } catch (e) {
          console.warn("⚠️ Could not verify promoted_object:", e.message);
        }
      } else {
        console.warn("⚠️ promoted_object is empty, not including in payload");
      }
    }

    console.log("Creating AdSet with payload:", {
      ...payload,
      targeting: payload.targeting?.substring(0, 100),
    });
    console.log("Campaign ID:", campaignId);

    // Always use ad account endpoint (more reliable than campaign endpoint)
    // The campaign endpoint often fails because campaigns aren't immediately available
    let data;
    let actId = null;

    // Priority 1: Use provided adAccountId (MOST RELIABLE)
    if (adAccountId) {
      actId = String(adAccountId).startsWith("act_")
        ? String(adAccountId)
        : `act_${adAccountId}`;
      console.log("✅ Using provided ad account ID:", actId);
    } else {
      // Priority 2: Try to get ad account ID from campaign (may fail if campaign doesn't exist yet)
      console.log(
        "⚠️ No adAccountId provided, attempting to fetch from campaign:",
        campaignId
      );
      try {
        const campaignData = await fbRequest({
          method: "get",
          url: `${FB_GRAPH_BASE}/${campaignId}`,
          params: { fields: "account_id" },
          accessToken,
        });

        if (campaignData && campaignData.account_id) {
          actId = String(campaignData.account_id).startsWith("act_")
            ? String(campaignData.account_id)
            : `act_${campaignData.account_id}`;
          console.log("✅ Got ad account ID from campaign:", actId);
        } else {
          console.warn(
            "⚠️ Campaign data retrieved but no account_id found:",
            campaignData
          );
        }
      } catch (campaignErr) {
        console.error(
          "❌ Could not fetch campaign details:",
          campaignErr.fb?.message || campaignErr.message
        );
        // This is expected if campaign doesn't exist yet - we need adAccountId
      }
    }

    // Create AdSet via ad account endpoint (REQUIRED - campaign endpoint is unreliable)
    if (!actId) {
      const errorMsg =
        `Cannot create AdSet: Unable to determine ad account ID. ` +
        `Please provide 'adAccountId' in the request body. ` +
        `Campaign ${campaignId} may not be accessible yet or doesn't exist.`;
      throw Object.assign(new Error(errorMsg), { status: 400 });
    }

    // Validate campaign exists and get campaign objective
    // This prevents error 1487604 "Choose a campaign to create this ad set"
    let campaignObjective = null;
    try {
      const campaignData = await fbRequest({
        method: "get",
        url: `${FB_GRAPH_BASE}/${campaignId}`,
        params: { fields: "id,objective,account_id,status" },
        accessToken,
      });

      // Verify campaign exists and is accessible
      if (!campaignData || !campaignData.id) {
        throw Object.assign(
          new Error(
            `Campaign ${campaignId} not found or not accessible. Please verify the campaign ID is correct and you have access to it.`
          ),
          { status: 400 }
        );
      }

      // Verify campaign belongs to the same ad account
      if (campaignData.account_id) {
        const campaignActId = String(campaignData.account_id).startsWith("act_")
          ? String(campaignData.account_id)
          : `act_${campaignData.account_id}`;
        if (campaignActId !== actId) {
          throw Object.assign(
            new Error(
              `Campaign ${campaignId} belongs to a different ad account (${campaignActId}). AdSet must be created in the same ad account as the campaign (${actId}).`
            ),
            { status: 400 }
          );
        }
      }

      campaignObjective = campaignData?.objective;
      console.log("✅ Campaign validated:", {
        id: campaignData.id,
        objective: campaignObjective,
        status: campaignData.status,
        account_id: campaignData.account_id,
      });
      console.log("📋 Campaign objective:", campaignObjective);
    } catch (err) {
      console.warn("⚠️ Could not fetch campaign objective:", err.message);
      // Still continue - validation will fail gracefully if objective is required
    }

    // Validate destination_type against campaign objective
    if (destinationType) {
      // Normalize destination_type
      const normalizedDestinationType = destinationType.trim().toUpperCase();

      // Map extended destination types to standard types
      const destinationTypeMapping = {
        "WEBSITE": DESTINATION_TYPES.WEBSITE,
        "APP": DESTINATION_TYPES.APP,
        "LEAD_FORM": DESTINATION_TYPES.LEAD_FORM,
        "APP_STORE": DESTINATION_TYPES.APP,
        "APP_DEEP_LINK": DESTINATION_TYPES.APP,
        "INSTANT_FORM": DESTINATION_TYPES.LEAD_FORM,
        "CALLS": DESTINATION_TYPES.LEAD_FORM,
        "ON_AD": DESTINATION_TYPES.WEBSITE,
        "MESSAGING_APPS": DESTINATION_TYPES.WEBSITE,
        "PHONE_CALL": DESTINATION_TYPES.WEBSITE,
        "INSTAGRAM_PROFILE": DESTINATION_TYPES.WEBSITE,
        "FACEBOOK_PAGE": DESTINATION_TYPES.WEBSITE,
        "WHATSAPP": DESTINATION_TYPES.WEBSITE, // WHATSAPP maps to WEBSITE but requires whatsapp_number
      };

      // Map to standard destination type
      let mappedDestinationType = destinationTypeMapping[normalizedDestinationType];
      
      if (!mappedDestinationType) {
        // If not in mapping, check if it's already a valid standard type
        const validDestinationTypes = Object.values(DESTINATION_TYPES);
        if (validDestinationTypes.includes(normalizedDestinationType)) {
          mappedDestinationType = normalizedDestinationType;
        } else {
          throw Object.assign(
            new Error(
              `Invalid destination_type: ${destinationType}. Valid types: ${Object.keys(destinationTypeMapping).join(", ")}`
            ),
            { status: 400 }
          );
        }
      }

      // Use mapped destination type for validation
      const finalDestinationType = mappedDestinationType;

      // Validate against campaign objective (using mapped type)
      if (campaignObjective) {
        const validation = validateCampaignToAdSet(
          campaignObjective,
          finalDestinationType
        );
        if (!validation.valid) {
          const allowedDestinations = getAllowedDestinations(campaignObjective);
          throw Object.assign(
            new Error(
              `${
                validation.error
              }. Allowed destination types for ${campaignObjective}: ${allowedDestinations.join(
                ", "
              )}`
            ),
            { status: 400 }
          );
        }
        console.log(
          `✅ Destination type ${normalizedDestinationType} (mapped to ${finalDestinationType}) is valid for campaign objective ${campaignObjective}`
        );
      } else {
        console.warn(
          "⚠️ Could not fetch campaign objective for validation. Proceeding with destination_type validation skipped."
        );
      }

      // Store both original and mapped destination_type for later use
      req.body.destinationType = normalizedDestinationType; // Keep original for reference
      req.body.mappedDestinationType = finalDestinationType; // Store mapped type for API
    } else {
      // If destination_type not provided, try to infer from promoted_object
      if (promotedObject) {
        if (promotedObject.object_store_url || promotedObject.app_id) {
          req.body.destinationType = DESTINATION_TYPES.APP;
          console.log("📋 Inferred destination_type: APP from promoted_object");
        } else if (promotedObject.lead_gen_form_id) {
          req.body.destinationType = DESTINATION_TYPES.LEAD_FORM;
          console.log(
            "📋 Inferred destination_type: LEAD_FORM from promoted_object"
          );
        } else {
          req.body.destinationType = DESTINATION_TYPES.WEBSITE;
          console.log("📋 Inferred destination_type: WEBSITE (default)");
        }
      } else if (campaignObjective) {
        // Default based on campaign objective
        const allowedDestinations = getAllowedDestinations(campaignObjective);
        req.body.destinationType =
          allowedDestinations[0] || DESTINATION_TYPES.WEBSITE;
        console.log(
          `📋 Defaulted destination_type to ${req.body.destinationType} based on campaign objective ${campaignObjective}`
        );
      }
    }

    // Validate optimization_goal against campaign objective
    if (campaignObjective && finalOptimizationGoal) {
      const optValidation = validateOptimizationGoal(
        campaignObjective,
        finalOptimizationGoal
      );
      if (!optValidation.valid) {
        const allowedGoals = getAllowedOptimizationGoals(campaignObjective);
        throw Object.assign(
          new Error(
            `${
              optValidation.error
            }. Allowed optimization goals for ${campaignObjective}: ${allowedGoals.join(
              ", "
            )}`
          ),
          { status: 400 }
        );
      }
      console.log(
        `Optimization goal ${finalOptimizationGoal} is valid for campaign objective ${campaignObjective}`
      );
    }

    // Continue with optimization_goal validation if not LOWEST_COST_WITH_MIN_ROAS
    if (finalBidStrategy !== "LOWEST_COST_WITH_MIN_ROAS") {
      // Validate and adjust optimization_goal based on campaign objective
      // IMPORTANT: For new accounts, billing_event MUST remain IMPRESSIONS regardless of optimization_goal
      // For OUTCOME_TRAFFIC campaigns, optimization_goal should be LINK_CLICKS
      if (campaignObjective === "OUTCOME_TRAFFIC") {
        if (payload.optimization_goal !== "LINK_CLICKS") {
          console.log(
            `Adjusting optimization_goal from ${payload.optimization_goal} to LINK_CLICKS for OUTCOME_TRAFFIC campaign`
          );
          payload.optimization_goal = "LINK_CLICKS";
          // For new accounts, ALWAYS use IMPRESSIONS billing (don't change it)
          if (!isNewAccount && ALLOWED_BILLING_EVENTS.includes("LINK_CLICKS")) {
            payload.billing_event = "LINK_CLICKS";
          } else {
            // Keep IMPRESSIONS for new accounts or if LINK_CLICKS not allowed
            payload.billing_event = "IMPRESSIONS";
            if (isNewAccount) {
              console.warn(
                `⚠️ New account: Keeping billing_event as IMPRESSIONS (LINK_CLICKS not available for new accounts)`
              );
            }
          }
        }
      } else if (campaignObjective === "CONVERSIONS") {
        // For CONVERSIONS, can use CONVERSIONS or LINK_CLICKS
        if (payload.optimization_goal === "LINK_CLICKS") {
          // For new accounts, ALWAYS use IMPRESSIONS billing (don't change it)
          if (!isNewAccount && ALLOWED_BILLING_EVENTS.includes("LINK_CLICKS")) {
            payload.billing_event = "LINK_CLICKS";
          } else {
            // Keep IMPRESSIONS for new accounts or if LINK_CLICKS not allowed
            payload.billing_event = "IMPRESSIONS";
            if (isNewAccount) {
              console.warn(
                `⚠️ New account: Keeping billing_event as IMPRESSIONS (LINK_CLICKS not available for new accounts)`
              );
            }
          }
        } else if (payload.optimization_goal === "CONVERSIONS") {
          payload.billing_event = "IMPRESSIONS"; // CONVERSIONS typically uses IMPRESSIONS billing
        }
      }
    } else {
      console.log(
        "📋 Skipping campaign objective check - LOWEST_COST_WITH_MIN_ROAS requires optimization_goal = VALUE"
      );
    }

    // CRITICAL SAFETY CHECK: For new accounts, ALWAYS force IMPRESSIONS
    // This prevents the "Billing option not available" error (Subcode 2446404)
    if (isNewAccount && payload.billing_event !== "IMPRESSIONS") {
      console.warn(
        `⚠️ CRITICAL: New account detected - FORCING billing_event to IMPRESSIONS (was: ${payload.billing_event})`
      );
      console.warn(
        `   New accounts only support IMPRESSIONS billing. This prevents error 2446404.`
      );
      payload.billing_event = "IMPRESSIONS";
      billingEventChanged = true;
    }

    // Final validation: Ensure billing_event is in allowed list (universal safety check)
    // This is a critical check after all other modifications
    if (!ALLOWED_BILLING_EVENTS.includes(payload.billing_event)) {
      console.warn(
        `⚠️ Final check: Billing event '${payload.billing_event}' is not in allowed list. Replacing with IMPRESSIONS.`
      );
      payload.billing_event = "IMPRESSIONS";
      billingEventChanged = true;
    }

    // Ensure we never send unsupported billing events
    if (UNSUPPORTED_BILLING_EVENTS.includes(payload.billing_event)) {
      console.error(
        `❌ CRITICAL: Attempted to send unsupported billing_event '${payload.billing_event}'. Forcing IMPRESSIONS.`
      );
      payload.billing_event = "IMPRESSIONS";
      billingEventChanged = true;
    }

    // ULTIMATE SAFETY: If billing_event is not IMPRESSIONS, force it to IMPRESSIONS
    // This is a last resort to prevent error 2446404 for new accounts
    if (payload.billing_event !== "IMPRESSIONS" && forceImpressions) {
      console.warn(
        `⚠️ ULTIMATE SAFETY: Forcing billing_event to IMPRESSIONS to prevent error 2446404 (was: ${payload.billing_event})`
      );
      payload.billing_event = "IMPRESSIONS";
      billingEventChanged = true;
    }

    // Validate optimization_goal and billing_event compatibility
    // Skip validation for LOWEST_COST_WITH_MIN_ROAS (uses bid_constraints instead)
    if (finalBidStrategy !== "LOWEST_COST_WITH_MIN_ROAS") {
      const validCombinations = {
        LINK_CLICKS: ["LINK_CLICKS", "IMPRESSIONS"], // Allow both for new accounts
        CONVERSIONS: ["IMPRESSIONS", "LINK_CLICKS"],
        VALUE: ["IMPRESSIONS"], // For ROAS_GOAL, but billing_event should be IMPRESSIONS
        OUTCOME_TRAFFIC: ["LINK_CLICKS", "IMPRESSIONS"],
        OUTCOME_ENGAGEMENT: ["IMPRESSIONS"], // POST_ENGAGEMENT not allowed for new accounts
        OUTCOME_LEADS: ["IMPRESSIONS", "LINK_CLICKS"],
        OUTCOME_SALES: ["IMPRESSIONS"],
        OUTCOME_AWARENESS: ["IMPRESSIONS"],
        OUTCOME_APP_PROMOTION: ["IMPRESSIONS"],
        BRAND_AWARENESS: ["IMPRESSIONS"],
        REACH: ["IMPRESSIONS"],
        VIDEO_VIEWS: ["IMPRESSIONS"],
        POST_ENGAGEMENT: ["IMPRESSIONS"], // POST_ENGAGEMENT billing not allowed for new accounts
      };

      if (validCombinations[payload.optimization_goal]) {
        const validBillingEvents = validCombinations[payload.optimization_goal];
        // Filter to only include allowed billing events for new accounts
        const allowedValidEvents = validBillingEvents.filter((event) =>
          ALLOWED_BILLING_EVENTS.includes(event)
        );
        // For new accounts, ONLY use IMPRESSIONS regardless of what's valid
        const eventsToUse = isNewAccount
          ? ["IMPRESSIONS"]
          : allowedValidEvents.length > 0
          ? allowedValidEvents
          : ["IMPRESSIONS"];

        if (!eventsToUse.includes(payload.billing_event)) {
          const newBillingEvent = eventsToUse[0];
          console.warn(
            `⚠️ Billing event ${payload.billing_event} is not valid for ${
              payload.optimization_goal
            }${
              isNewAccount ? " (new account - must use IMPRESSIONS)" : ""
            }. Auto-correcting to: ${newBillingEvent}`
          );
          payload.billing_event = newBillingEvent;
          billingEventChanged = true;
          console.log(
            `✅ Auto-corrected billing_event to: ${payload.billing_event}`
          );
        }
      } else {
        // Unknown optimization_goal - ensure billing_event is in allowed list
        if (!ALLOWED_BILLING_EVENTS.includes(payload.billing_event)) {
          console.warn(
            `⚠️ Unknown optimization_goal: ${payload.optimization_goal}. Replacing billing_event with IMPRESSIONS (was: ${payload.billing_event})`
          );
          payload.billing_event = "IMPRESSIONS";
        }
      }
    } else {
      console.log(
        "📋 Skipping optimization_goal/billing_event validation - LOWEST_COST_WITH_MIN_ROAS uses bid_constraints"
      );
      // Ensure billing_event is not VALUE for ROAS_GOAL (already handled in switch case above)
      if (
        payload.billing_event === "VALUE" ||
        !ALLOWED_BILLING_EVENTS.includes(payload.billing_event)
      ) {
        console.warn(
          `⚠️ Billing event '${payload.billing_event}' is not allowed with LOWEST_COST_WITH_MIN_ROAS. Replacing with IMPRESSIONS.`
        );
        payload.billing_event = "IMPRESSIONS";
        billingEventChanged = true;
      }
    }

    // Log billing event change for user notification
    if (billingEventChanged) {
      console.warn(
        `⚠️ Billing event has been changed to IMPRESSIONS because this ad account does not support the selected option.`
      );
    }

    // Clean undefined/null/NaN fields from payload before sending to Facebook
    const cleanPayload = {};
    for (const [key, value] of Object.entries(payload)) {
      // Remove undefined, null, and NaN values
      if (
        value !== undefined &&
        value !== null &&
        !(typeof value === "number" && isNaN(value))
      ) {
        cleanPayload[key] = value;
      }
    }

    // CRITICAL FINAL CHECK: Always force IMPRESSIONS for new accounts before sending
    // This prevents error 2446404 "Billing option not available"
    if (forceImpressions && cleanPayload.billing_event !== "IMPRESSIONS") {
      console.warn(
        `⚠️ CRITICAL FINAL CHECK: Forcing billing_event to IMPRESSIONS before sending to Meta API (was: ${cleanPayload.billing_event})`
      );
      console.warn(`   This prevents error 2446404 for new ad accounts.`);
      cleanPayload.billing_event = "IMPRESSIONS";
      billingEventChanged = true;
    }

    // Final safety check: Ensure billing_event is in allowed list before sending
    if (!ALLOWED_BILLING_EVENTS.includes(cleanPayload.billing_event)) {
      console.error(
        `❌ CRITICAL: Final payload has invalid billing_event '${cleanPayload.billing_event}'. Forcing IMPRESSIONS.`
      );
      cleanPayload.billing_event = "IMPRESSIONS";
      billingEventChanged = true;
    }

    // ULTIMATE SAFETY: If still not IMPRESSIONS, force it (prevents all billing errors)
    if (cleanPayload.billing_event !== "IMPRESSIONS") {
      console.error(
        `❌ ULTIMATE SAFETY: billing_event is '${cleanPayload.billing_event}' - FORCING to IMPRESSIONS to prevent errors`
      );
      cleanPayload.billing_event = "IMPRESSIONS";
      billingEventChanged = true;
    }

    // Ensure promoted_object is properly formatted as JSON string if present
    // CRITICAL: Remove any camelCase keys (like pageId) - Meta API only accepts snake_case
    if (cleanPayload.promoted_object) {
      if (typeof cleanPayload.promoted_object === "object") {
        // Remove pageId (camelCase) if present - Meta API rejects it
        const { pageId: _, ...cleanedPromotedObject } =
          cleanPayload.promoted_object;
        // Only keep valid Meta API keys (snake_case)
        const validKeys = [
          "page_id",
          "application_id",
          "object_store_url",
          "pixel_id",
          "custom_event_type",
        ];
        const finalPromotedObject = {};
        Object.keys(cleanedPromotedObject).forEach((key) => {
          if (validKeys.includes(key)) {
            finalPromotedObject[key] = cleanedPromotedObject[key];
          }
        });
        cleanPayload.promoted_object = JSON.stringify(finalPromotedObject);
        console.log(
          "ℹ️ Converted promoted_object to JSON string (removed pageId, kept only valid keys)"
        );
      } else if (typeof cleanPayload.promoted_object === "string") {
        // If it's already a string, parse it, clean it, and stringify again
        try {
          const parsed = JSON.parse(cleanPayload.promoted_object);
          // Remove pageId (camelCase) if present
          const { pageId: _, ...cleanedPromotedObject } = parsed;
          // Only keep valid Meta API keys (snake_case)
          const validKeys = [
            "page_id",
            "application_id",
            "object_store_url",
            "pixel_id",
            "custom_event_type",
          ];
          const finalPromotedObject = {};
          Object.keys(cleanedPromotedObject).forEach((key) => {
            if (validKeys.includes(key)) {
              finalPromotedObject[key] = cleanedPromotedObject[key];
            }
          });
          cleanPayload.promoted_object = JSON.stringify(finalPromotedObject);
          console.log(
            "ℹ️ Cleaned promoted_object JSON string (removed pageId, kept only valid keys)"
          );
        } catch (e) {
          console.warn(
            "⚠️ Could not parse promoted_object as JSON, keeping as-is:",
            e.message
          );
        }
      }
    }

    // Log final cleaned payload for debugging - EXACT Meta API payload format
    console.log("=".repeat(80));
    console.log("📦 EXACT META API PAYLOAD (Ready to send to Meta):");
    console.log("=".repeat(80));
    console.log(JSON.stringify(cleanPayload, null, 2));
    console.log("=".repeat(80));
    console.log(
      `✅ Final billing_event: ${cleanPayload.billing_event}${
        billingEventChanged ? " (was changed)" : ""
      }`
    );
    if (cleanPayload.promoted_object) {
      console.log(
        `✅ promoted_object (JSON string): ${cleanPayload.promoted_object}`
      );
      try {
        const parsedPromotedObject = JSON.parse(cleanPayload.promoted_object);
        console.log(
          `✅ promoted_object (parsed):`,
          JSON.stringify(parsedPromotedObject, null, 2)
        );
      } catch (e) {
        console.warn("⚠️ Could not parse promoted_object:", e.message);
      }
    }
    console.log(`✅ Campaign ID: ${cleanPayload.campaign_id || campaignId}`);
    console.log(`✅ Ad Account ID: ${actId}`);
    console.log(`✅ Optimization Goal: ${cleanPayload.optimization_goal}`);
    console.log(`✅ Daily Budget: ${cleanPayload.daily_budget} (paise)`);
    if (cleanPayload.targeting) {
      try {
        const parsedTargeting =
          typeof cleanPayload.targeting === "string"
            ? JSON.parse(cleanPayload.targeting)
            : cleanPayload.targeting;
        console.log(`✅ Targeting:`, JSON.stringify(parsedTargeting, null, 2));
      } catch (e) {
        console.log(
          `✅ Targeting: ${cleanPayload.targeting.substring(0, 200)}...`
        );
      }
    }
    console.log("=".repeat(80));

    try {
      console.log("🚀 Sending AdSet creation request to Meta API...");
      console.log(`   Endpoint: POST ${FB_GRAPH_BASE}/${actId}/adsets`);

      data = await fbRequest({
        method: "post",
        url: `${FB_GRAPH_BASE}/${actId}/adsets`,
        data: cleanPayload,
        accessToken,
      });

      console.log("✅ AdSet created successfully:", data.id);

      // Return billing event change notification if it was changed
      if (billingEventChanged) {
        res.status(201).json({
          success: true,
          adset: data,
          warning:
            "Billing event has been changed to IMPRESSIONS because this ad account does not support the selected option.",
        });
        return;
      }
    } catch (accountErr) {
      // Handle specific Meta API errors
      if (accountErr.fb?.error_subcode === 1487604) {
        // Error 1487604: "Choose a campaign to create this ad set"
        // This usually means the campaign doesn't exist, is invalid, or belongs to a different ad account
        const errorMsg =
          `Cannot create AdSet: Campaign ${campaignId} is invalid or not accessible. ` +
          `Error: ${
            accountErr.fb?.error_user_msg ||
            accountErr.fb?.message ||
            "Choose a campaign to create this ad set"
          }. ` +
          `Please verify: ` +
          `1. The campaign ID (${campaignId}) is correct ` +
          `2. The campaign exists and is accessible ` +
          `3. The campaign belongs to the same ad account (${actId}) ` +
          `4. You have permission to access this campaign`;
        throw Object.assign(new Error(errorMsg), {
          status: 400,
          fbError: accountErr.fb,
        });
      }
      const errorMessage =
        accountErr.fb?.message || accountErr.message || "Unknown error";
      const errorCode = accountErr.fb?.code || accountErr.status;

      console.error("❌ Failed to create adset via ad account:", errorMessage);
      console.error("Error code:", errorCode);
      console.error("Full error:", JSON.stringify(accountErr.fb, null, 2));

      // Provide helpful error message with detailed Facebook error
      let userMessage = `Failed to create AdSet using ad account ${actId}.\n\n`;

      if (accountErr.fb) {
        userMessage += `Facebook Error: ${
          accountErr.fb.message || errorMessage
        }`;
        if (accountErr.fb.error_user_msg) {
          userMessage += `\n\n${accountErr.fb.error_user_msg}`;
        }
        if (accountErr.fb.error_subcode) {
          userMessage += `\n\nError Code: ${
            accountErr.fb.code || errorCode
          } (Subcode: ${accountErr.fb.error_subcode})`;
        }
        if (accountErr.fb.error_user_title) {
          userMessage = `${accountErr.fb.error_user_title}\n\n${userMessage}`;
        }
      } else {
        if (errorCode === 100) {
          // Check for specific subcodes
          if (accountErr.fb?.error_subcode === 1815430) {
            // Missing conversion event/dataset
            userMessage +=
              "Select a dataset and conversion event for your ad set. ";
            if (finalOptimizationGoal === "OFFSITE_CONVERSIONS") {
              userMessage +=
                "For OFFSITE_CONVERSIONS optimization goal, you must provide pixel_id and conversion_event in the promoted_object. ";
              userMessage +=
                "Please include pixel_id (Facebook Pixel ID) and conversion_event (e.g., PURCHASE, ADD_TO_CART, LEAD).";
            } else if (
              finalOptimizationGoal === "APP_INSTALLS" ||
              finalOptimizationGoal === "APP_ENGAGEMENT"
            ) {
              userMessage +=
                "For APP_INSTALLS optimization goal, you must provide promoted_object with app_id (application_id). ";
              userMessage +=
                "Please include app_id in the promoted_object field.";
            } else {
              userMessage +=
                "Please provide the required conversion tracking information for your optimization goal.";
            }
          } else if (accountErr.fb?.error_subcode === 1885011) {
            // Missing object_store_url
            userMessage += "Object Store URL is required. ";
            userMessage +=
              "When promoting a mobile or canvas app, you must provide an 'object_store_url' parameter in the promoted_object. ";
            userMessage +=
              "Please provide the App Store URL (Apple App Store or Google Play Store).";
          } else if (accountErr.fb?.error_subcode === 1885012) {
            // Missing application_id
            userMessage += "Application ID is required. ";
            userMessage +=
              "When promoting a mobile or canvas app, you must provide an 'application_id' (app_id) parameter in the promoted_object. ";
            userMessage += "Please provide the Facebook App ID.";
          } else if (accountErr.fb?.error_subcode === 1885093) {
            // Application/Object Store URL Mismatch
            userMessage += "Application/Object Store URL Mismatch. ";
            userMessage +=
              "The application_id doesn't match the provided object_store_url. ";
            userMessage +=
              "Please ensure the App ID corresponds to the app in the App Store URL. ";
            userMessage +=
              "Verify the app configuration at: https://developers.facebook.com/apps/";
          } else {
            userMessage +=
              "Invalid parameter. Please check your targeting, budget, and optimization settings.";
          }
        } else if (errorCode === 190) {
          userMessage +=
            "Invalid access token. Please reconnect your Facebook account.";
        } else if (errorCode === 1487296) {
          userMessage +=
            "Invalid campaign ID. The campaign may not exist or you may not have permissions.";
        } else {
          userMessage += `Error: ${errorMessage}`;
        }
      }

      throw Object.assign(new Error(userMessage), {
        status: accountErr.status || 400,
        fb: accountErr.fb,
      });
    }

    res.status(201).json({ success: true, adset: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Update AdSet
exports.updateAdSet = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adsetId } = req.params;
    requireFields({ adsetId }, ["adsetId"]);

    const updatable = [
      "name",
      "status",
      "optimization_goal",
      "billing_event",
      "bid_amount",
      "daily_budget",
      "lifetime_budget",
      "targeting",
      "start_time",
      "end_time",
    ];

    const body = {};
    for (const key of updatable) {
      if (req.body?.[key] !== undefined) {
        if (key === "targeting" && typeof req.body[key] === "object") {
          body[key] = JSON.stringify(req.body[key]);
        } else {
          body[key] = req.body[key];
        }
      }
    }

    if (!Object.keys(body).length)
      throw Object.assign(new Error("No editable fields provided"), {
        status: 400,
      });

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${adsetId}`,
      data: body,
      accessToken,
    });

    res.json({ success: true, result: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Get All AdSets
exports.getAllAdSets = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { campaignId } = req.query;
    requireFields({ campaignId }, ["campaignId"]);

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${campaignId}/adsets`,
      params: {
        fields:
          "id,name,status,optimization_goal,billing_event,daily_budget,lifetime_budget,bid_amount,effective_status,targeting,promoted_object",
      },
      accessToken,
    });

    // Add destination_type to each adset
    const adsetsWithDestination = Array.isArray(data.data)
      ? data.data.map((adset) => {
          let destinationType = null;
          if (adset.promoted_object) {
            if (
              adset.promoted_object.object_store_url ||
              adset.promoted_object.app_id
            ) {
              destinationType = DESTINATION_TYPES.APP;
            } else if (adset.promoted_object.lead_gen_form_id) {
              destinationType = DESTINATION_TYPES.LEAD_FORM;
            } else {
              destinationType = DESTINATION_TYPES.WEBSITE;
            }
          }
          return {
            ...adset,
            destination_type: destinationType,
            allowed_cta_types: destinationType
              ? getAllowedCTAs(destinationType)
              : [],
          };
        })
      : data;

    res.json({
      success: true,
      adsets: Array.isArray(data.data)
        ? { ...data, data: adsetsWithDestination }
        : adsetsWithDestination,
    });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Get Single AdSet
exports.getAdSetById = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adsetId } = req.params;
    requireFields({ adsetId }, ["adsetId"]);

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${adsetId}`,
      params: {
        fields:
          "id,name,status,optimization_goal,billing_event,daily_budget,lifetime_budget,bid_amount,effective_status,targeting,campaign_id,start_time,end_time,promoted_object,campaign{objective}",
      },
      accessToken,
    });

    // Infer destination_type from promoted_object or campaign objective
    let destinationType = null;
    if (data.promoted_object) {
      if (
        data.promoted_object.object_store_url ||
        data.promoted_object.app_id
      ) {
        destinationType = DESTINATION_TYPES.APP;
      } else if (data.promoted_object.lead_gen_form_id) {
        destinationType = DESTINATION_TYPES.LEAD_FORM;
      } else {
        destinationType = DESTINATION_TYPES.WEBSITE;
      }
    } else if (data.campaign && data.campaign.objective) {
      const allowedDestinations = getAllowedDestinations(
        data.campaign.objective
      );
      destinationType = allowedDestinations[0] || DESTINATION_TYPES.WEBSITE;
    }

    // Add destination_type and allowed CTAs to response
    const response = {
      ...data,
      destination_type: destinationType,
      allowed_cta_types: destinationType ? getAllowedCTAs(destinationType) : [],
    };

    res.json({ success: true, adset: response });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Pause AdSet
exports.pauseAdSet = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adsetId } = req.params;
    requireFields({ adsetId }, ["adsetId"]);

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${adsetId}`,
      data: { status: "PAUSED" },
      accessToken,
    });

    res.json({ success: true, result: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Activate AdSet
exports.activateAdSet = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adsetId } = req.params;
    requireFields({ adsetId }, ["adsetId"]);

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${adsetId}`,
      data: { status: "ACTIVE" },
      accessToken,
    });

    res.json({ success: true, result: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Delete AdSet
exports.deleteAdSet = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adsetId } = req.params;
    requireFields({ adsetId }, ["adsetId"]);

    const data = await fbRequest({
      method: "delete",
      url: `${FB_GRAPH_BASE}/${adsetId}`,
      accessToken,
    });

    res.json({ success: true, result: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Get Targeting Search (for regions and cities)
// Search for Meta Ad Geolocation (Regions/Cities) by place name
exports.searchAdGeolocation = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken) {
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    }

    const {
      q,
      location_types,
      latitude,
      longitude,
      distance = 10000,
    } = req.query;

    if (!q || q.trim() === "") {
      throw Object.assign(new Error("Query parameter 'q' is required"), {
        status: 400,
      });
    }

    console.log("🔍 Searching Meta Ad Geolocation for:", q);
    console.log("📍 Location types:", location_types);
    console.log("📍 Coordinates:", { latitude, longitude });
    console.log("📍 Distance:", distance);

    // Meta API expects location_types as an array in the format: ['region','city']
    // Default to both region and city if not specified
    let locationTypesParam;
    if (location_types) {
      if (Array.isArray(location_types)) {
        // Convert array to string format: ['region','city']
        locationTypesParam = `[${location_types
          .map((t) => `'${t}'`)
          .join(",")}]`;
      } else if (typeof location_types === "string") {
        // If it's a string, try to parse it or use as single value
        if (location_types.includes(",")) {
          // Multiple types: "region,city"
          const types = location_types.split(",").map((t) => t.trim());
          locationTypesParam = `[${types.map((t) => `'${t}'`).join(",")}]`;
        } else {
          // Single type: "region"
          locationTypesParam = `['${location_types}']`;
        }
      } else {
        locationTypesParam = `['region','city']`; // Default to both
      }
    } else {
      // Default to both region and city if not specified
      locationTypesParam = `['region','city']`;
    }

    console.log("📍 Location types param:", locationTypesParam);

    // Build URL manually to ensure location_types is in the correct format
    // Meta API expects: location_types=['region','city'] as a raw string in the URL
    let url = `${FB_GRAPH_BASE}/search?type=adgeolocation&q=${encodeURIComponent(
      q.trim()
    )}&location_types=${locationTypesParam}&access_token=${accessToken}`;

    // Add coordinates if provided
    if (latitude && longitude) {
      url += `&latitude=${latitude}&longitude=${longitude}`;
    }

    // Add distance if provided (in meters)
    if (distance) {
      url += `&distance=${distance}`;
    }

    console.log("🔗 Request URL:", url.replace(accessToken, "REDACTED"));

    const response = await axios.get(url);

    console.log(
      "✅ Meta Ad Geolocation search response:",
      JSON.stringify(response.data, null, 2)
    );

    // Meta returns data in format: { data: [...] }
    const results = response.data?.data || [];

    if (results.length === 0) {
      console.log("⚠️ No results found for query:", q);
    }

    res.json({
      success: true,
      query: q,
      location_types: location_types,
      results: results,
      count: results.length,
    });
  } catch (err) {
    // Check for token expiration first
    if (err.isTokenExpired || (err.fb && err.fb.code === 190 && err.fb.error_subcode === 463)) {
      return handleError(err, res, next);
    }
    
    console.error("❌ searchAdGeolocation error:", err);
    console.error("❌ Error response:", err.response?.data);
    console.error("❌ Error status:", err.response?.status);

    // Handle Meta API errors
    if (err.response?.data?.error) {
      const fbError = err.response.data.error;
      
      // Check for token expiration in response
      if (fbError.code === 190 && fbError.error_subcode === 463) {
        return handleError(createTokenExpiredError({ fb: fbError }), res, next);
      }
      
      console.error("❌ Meta API Error Details:", {
        message: fbError.message,
        error_user_msg: fbError.error_user_msg,
        code: fbError.code,
        type: fbError.type,
        subcode: fbError.error_subcode,
      });

      return res.status(err.response.status || 400).json({
        success: false,
        error: fbError.message || fbError.error_user_msg || "Meta API error",
        errorCode: fbError.code,
        errorType: fbError.type,
        errorSubcode: fbError.error_subcode,
        metaError: fbError,
      });
    }

    // Handle network/other errors
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to search Meta geolocation",
      details: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

// Get validation information for frontend
exports.getValidationInfo = async (req, res, next) => {
  try {
    const { campaignObjective, destinationType } = req.query;

    const {
      CAMPAIGN_OBJECTIVES,
      CAMPAIGN_ADSET_MAPPING_V23,
      DESTINATION_TYPES,
      CTA_TYPES,
      getAllowedDestinations,
      getAllowedCTAs,
      getAllowedOptimizationGoals,
      getAllowedCTAsForObjective,
      getAllowedObjectTypes,
    } = require("../../utils/metaValidation");

    const response = {
      campaign_objectives: Object.values(CAMPAIGN_OBJECTIVES),
      destination_types: Object.values(DESTINATION_TYPES),
      cta_types: CTA_TYPES,
      campaign_adset_mapping: CAMPAIGN_ADSET_MAPPING_V23,
    };

    // If campaign objective provided, return all related info
    if (campaignObjective) {
      response.allowed_destinations = getAllowedDestinations(campaignObjective);
      response.allowed_optimization_goals =
        getAllowedOptimizationGoals(campaignObjective);
      response.allowed_cta_types =
        getAllowedCTAsForObjective(campaignObjective);
      response.allowed_object_types = getAllowedObjectTypes(campaignObjective);
    }

    // If destination type provided, return allowed CTAs
    if (destinationType) {
      response.allowed_cta_types_by_destination =
        getAllowedCTAs(destinationType);
    }

    res.json({ success: true, validation: response });
  } catch (err) {
    return handleError(err, res, next);
  }
};

exports.getTargetingSearch = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { q, type, country_code } = req.query;

    if (!q || !type) {
      throw Object.assign(
        new Error(
          "Missing required query parameters: q (search query) and type (adgeolocation)"
        ),
        { status: 400 }
      );
    }

    // Meta API uses 'adgeolocation' type for both regions and cities
    // The location_class parameter can be used to filter: 'region' or 'city'
    const params = {
      q: q,
      type: "adgeolocation",
      limit: 50,
    };

    if (country_code) {
      params.country_code = country_code;
    }

    // Add location_class if specified (region or city)
    if (type === "region" || type === "city") {
      params.location_class = type;
    }

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/search`,
      params,
      accessToken,
    });

    res.json({ success: true, data: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Get WhatsApp Business Accounts (WABA) and Phone Numbers
// Flow: /me/businesses -> /{BUSINESS_ID}/owned_whatsapp_business_accounts -> /{WABA_ID}/phone_numbers
exports.getWhatsAppBusinessAccounts = async (req, res, next) => {
  const accessToken = getAccessToken(req);

  try {
    if (!accessToken) {
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    }

    console.log("🔄 Step 1: Fetching businesses from /me/businesses");
    
    // Step 1: Get all business accounts
    const businessData = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/me/businesses`,
      params: {
        fields: "id,name",
      },
      accessToken,
    });

    const businessAccounts = businessData.data || [];
    console.log(`📊 Step 1 Complete: Found ${businessAccounts.length} business account(s)`, businessAccounts);

    if (businessAccounts.length === 0) {
      return res.json({
        success: true,
        wabaAccounts: [],
        phoneNumbers: [],
        businesses: [],
        message: "No business accounts found. Please create a business account in Meta Business Manager first.",
      });
    }

    // Step 2 & 3: Get WABA from each business, then get phone numbers from each WABA
    const allWabaAccounts = [];
    const allPhoneNumbers = [];

    console.log("🔄 Step 2: Fetching WABA accounts for each business");
    
    for (const business of businessAccounts) {
      console.log(`  📍 Processing business: ${business.name} (${business.id})`);
      
      try {
        // Step 2: Get WABA accounts for this business
        // Try multiple endpoints as different setups might use different endpoints
        let wabaAccounts = [];
        
        // Method 1: Try owned_whatsapp_business_accounts
        try {
          console.log(`  🔍 Method 1: Trying /${business.id}/owned_whatsapp_business_accounts`);
          const wabaData = await fbRequest({
            method: "get",
            url: `${FB_GRAPH_BASE}/${business.id}/owned_whatsapp_business_accounts`,
            params: {
              fields: "id,name,account_review_status,message_template_namespace,timezone_id,currency",
            },
            accessToken,
          });
          
          console.log(`  📥 Method 1 Response:`, JSON.stringify(wabaData, null, 2));
          wabaAccounts = wabaData.data || [];
          console.log(`  ✅ Method 1 (owned_whatsapp_business_accounts): Found ${wabaAccounts.length} WABA account(s)`);
          
          if (wabaAccounts.length === 0 && wabaData.data === undefined) {
            console.warn(`  ⚠️ Method 1 returned unexpected structure:`, wabaData);
          }
        } catch (method1Error) {
          console.warn(`  ⚠️ Method 1 failed for business ${business.id}:`, method1Error.message);
          if (method1Error.fb) {
            console.warn(`  ⚠️ Method 1 Facebook Error:`, JSON.stringify(method1Error.fb, null, 2));
          }
          
          // Method 2: Try whatsapp_business_accounts (alternative endpoint)
          try {
            console.log(`  🔍 Method 2: Trying /${business.id}/whatsapp_business_accounts`);
            const wabaData2 = await fbRequest({
              method: "get",
              url: `${FB_GRAPH_BASE}/${business.id}/whatsapp_business_accounts`,
              params: {
                fields: "id,name,account_review_status,message_template_namespace,timezone_id,currency",
              },
              accessToken,
            });
            
            console.log(`  📥 Method 2 Response:`, JSON.stringify(wabaData2, null, 2));
            wabaAccounts = wabaData2.data || [];
            console.log(`  ✅ Method 2 (whatsapp_business_accounts): Found ${wabaAccounts.length} WABA account(s)`);
          } catch (method2Error) {
            console.warn(`  ⚠️ Method 2 failed for business ${business.id}:`, method2Error.message);
            if (method2Error.fb) {
              console.warn(`  ⚠️ Method 2 Facebook Error:`, JSON.stringify(method2Error.fb, null, 2));
            }
            
            // Method 3: Try accessing WABA directly from business with different field
            try {
              console.log(`  🔍 Method 3: Trying /${business.id} with whatsapp_business_accounts field`);
              const businessDetails = await fbRequest({
                method: "get",
                url: `${FB_GRAPH_BASE}/${business.id}`,
                params: {
                  fields: "id,name,whatsapp_business_accounts{id,name,account_review_status}",
                },
                accessToken,
              });
              
              console.log(`  📥 Method 3 Response:`, JSON.stringify(businessDetails, null, 2));
              
              if (businessDetails.whatsapp_business_accounts) {
                wabaAccounts = businessDetails.whatsapp_business_accounts.data || [];
                console.log(`  ✅ Method 3 (business fields): Found ${wabaAccounts.length} WABA account(s)`);
              } else {
                console.log(`  ℹ️ Method 3: No whatsapp_business_accounts field in response`);
              }
            } catch (method3Error) {
              console.warn(`  ⚠️ Method 3 failed for business ${business.id}:`, method3Error.message);
              if (method3Error.fb) {
                console.warn(`  ⚠️ Method 3 Facebook Error:`, JSON.stringify(method3Error.fb, null, 2));
              }
            }
          }
        }
        
        console.log(`  📊 Total WABA accounts found for business ${business.name}: ${wabaAccounts.length}`);
        
        if (wabaAccounts.length > 0) {
          // Add business info to each WABA
          const wabaAccountsWithBusiness = wabaAccounts.map(waba => ({
            ...waba,
            business_id: business.id,
            business_name: business.name,
          }));
          
          allWabaAccounts.push(...wabaAccountsWithBusiness);

          console.log("🔄 Step 3: Fetching phone numbers for each WABA");
          
          // Step 3: Get phone numbers for each WABA
          for (const waba of wabaAccounts) {
            console.log(`  📍 Processing WABA: ${waba.name || waba.id}`);
            
            try {
              const phoneNumbersData = await fbRequest({
                method: "get",
                url: `${FB_GRAPH_BASE}/${waba.id}/phone_numbers`,
                params: {
                  fields: "id,verified_name,display_phone_number,phone_number,code_verification_status,quality_rating,throughput,is_official_business_account",
                },
                accessToken,
              });

              const phoneNumbers = phoneNumbersData.data || [];
              console.log(`  ✅ Found ${phoneNumbers.length} phone number(s) for WABA ${waba.name || waba.id}`);
              
              if (phoneNumbers.length > 0) {
                // Add WABA and business info to each phone number
                const phoneNumbersWithContext = phoneNumbers.map(phone => ({
                  ...phone,
                  waba_id: waba.id,
                  waba_name: waba.name,
                  business_id: business.id,
                  business_name: business.name,
                }));
                
                allPhoneNumbers.push(...phoneNumbersWithContext);
              }
            } catch (phoneError) {
              console.error(`  ❌ Error fetching phone numbers for WABA ${waba.id}:`, phoneError.message);
              if (phoneError.fb) {
                console.error(`  Facebook Error:`, phoneError.fb);
              }
              // Continue with next WABA
            }
          }
        }
      } catch (wabaError) {
        console.error(`  ❌ Error fetching WABA for business ${business.id}:`, wabaError.message);
        if (wabaError.fb) {
          console.error(`  Facebook Error:`, JSON.stringify(wabaError.fb, null, 2));
        }
        // Continue with next business account
      }
    }
    
    // Additional fallback: Try to get WABA accounts directly from /me endpoint
    // This might work if the user has direct access to WABA accounts
    if (allWabaAccounts.length === 0) {
      console.log("🔄 Fallback: Trying to get WABA accounts directly from /me/whatsapp_business_accounts");
      try {
        const meWabaData = await fbRequest({
          method: "get",
          url: `${FB_GRAPH_BASE}/me/whatsapp_business_accounts`,
          params: {
            fields: "id,name,account_review_status,message_template_namespace,timezone_id,currency",
          },
          accessToken,
        });
        
        console.log(`  📥 /me/whatsapp_business_accounts Response:`, JSON.stringify(meWabaData, null, 2));
        const meWabaAccounts = meWabaData.data || [];
        
        if (meWabaAccounts.length > 0) {
          console.log(`  ✅ Fallback: Found ${meWabaAccounts.length} WABA account(s) from /me endpoint`);
          
          // Try to match WABA accounts with businesses
          for (const waba of meWabaAccounts) {
            // Try to get the business that owns this WABA
            try {
              const wabaDetails = await fbRequest({
                method: "get",
                url: `${FB_GRAPH_BASE}/${waba.id}`,
                params: {
                  fields: "id,name,account_review_status,owned_by{id,name}",
                },
                accessToken,
              });
              
              let businessId = null;
              let businessName = null;
              
              if (wabaDetails.owned_by) {
                businessId = wabaDetails.owned_by.id;
                businessName = wabaDetails.owned_by.name;
              }
              
              // If we can't find the business, try to match with one of the known businesses
              if (!businessId && businessAccounts.length > 0) {
                // For now, assign to the first business or try to find a match
                businessId = businessAccounts[0].id;
                businessName = businessAccounts[0].name;
              }
              
              allWabaAccounts.push({
                ...waba,
                business_id: businessId,
                business_name: businessName,
              });
              
              // Get phone numbers for this WABA
              try {
                const phoneNumbersData = await fbRequest({
                  method: "get",
                  url: `${FB_GRAPH_BASE}/${waba.id}/phone_numbers`,
                  params: {
                    fields: "id,verified_name,display_phone_number,phone_number,code_verification_status,quality_rating,throughput,is_official_business_account",
                  },
                  accessToken,
                });
                
                const phoneNumbers = phoneNumbersData.data || [];
                if (phoneNumbers.length > 0) {
                  const phoneNumbersWithContext = phoneNumbers.map(phone => ({
                    ...phone,
                    waba_id: waba.id,
                    waba_name: waba.name,
                    business_id: businessId,
                    business_name: businessName,
                  }));
                  
                  allPhoneNumbers.push(...phoneNumbersWithContext);
                }
              } catch (phoneError) {
                console.warn(`  ⚠️ Could not fetch phone numbers for WABA ${waba.id}:`, phoneError.message);
              }
            } catch (wabaDetailsError) {
              console.warn(`  ⚠️ Could not get details for WABA ${waba.id}:`, wabaDetailsError.message);
            }
          }
        }
      } catch (meWabaError) {
        console.warn(`  ⚠️ Fallback method failed:`, meWabaError.message);
        if (meWabaError.fb) {
          console.warn(`  ⚠️ Fallback Facebook Error:`, JSON.stringify(meWabaError.fb, null, 2));
        }
      }
    }

    console.log(`✅ Complete: Found ${allWabaAccounts.length} WABA account(s) and ${allPhoneNumbers.length} phone number(s)`);

    res.json({
      success: true,
      wabaAccounts: allWabaAccounts,
      phoneNumbers: allPhoneNumbers,
      businesses: businessAccounts,
      message: allWabaAccounts.length === 0 
        ? "No WhatsApp Business Accounts found. Please create a WABA in Meta Business Manager first."
        : `Found ${allWabaAccounts.length} WhatsApp Business Account(s) and ${allPhoneNumbers.length} phone number(s)`,
    });
  } catch (error) {
    console.error("❌ Error fetching WhatsApp Business Accounts:", error);
    if (error.fb) {
      console.error("Facebook Error Details:", error.fb);
    }
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to fetch WhatsApp Business Accounts",
      fb: error.fb,
      hint: "Make sure you have a WhatsApp Business Account created in Meta Business Manager and the access token has 'whatsapp_business_management' permission.",
    });
  }
};

// Get verified phone numbers for a WABA
exports.getWhatsAppPhoneNumbers = async (req, res, next) => {
  const accessToken = getAccessToken(req);

  try {
    if (!accessToken) {
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    }

    const { wabaId } = req.params;

    if (!wabaId) {
      throw Object.assign(
        new Error("WABA ID is required"),
        { status: 400 }
      );
    }

    // Get verified phone numbers for the WABA
    const phoneNumbersData = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${wabaId}/phone_numbers`,
      params: {
        fields: "id,verified_name,display_phone_number,phone_number,code_verification_status,quality_rating,throughput,is_official_business_account",
      },
      accessToken,
    });

    res.json({
      success: true,
      phoneNumbers: phoneNumbersData.data || [],
    });
  } catch (error) {
    console.error("Error fetching WhatsApp phone numbers:", error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to fetch WhatsApp phone numbers",
      fb: error.fb,
    });
  }
};

// Verify/Register a WhatsApp phone number
exports.verifyWhatsAppPhoneNumber = async (req, res, next) => {
  const accessToken = getAccessToken(req);

  try {
    if (!accessToken) {
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    }

    const { wabaId, phoneNumber, verifiedName, displayName, pin } = req.body;

    if (!wabaId || !phoneNumber) {
      throw Object.assign(
        new Error("WABA ID and phone number are required"),
        { status: 400 }
      );
    }

    // Register/verify phone number
    const payload = {
      verified_name: verifiedName || "",
      display_name: displayName || "",
      phone_number: phoneNumber,
    };

    if (pin) {
      payload.pin = pin;
    }

    const result = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${wabaId}/phone_numbers`,
      data: payload,
      accessToken,
    });

    res.json({
      success: true,
      phoneNumber: result,
      message: "Phone number verification initiated successfully",
    });
  } catch (error) {
    console.error("Error verifying WhatsApp phone number:", error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to verify WhatsApp phone number",
      fb: error.fb,
    });
  }
};
