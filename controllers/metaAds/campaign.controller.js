// File: controllers/campaignController.js
const axios = require("axios");
const { isTokenExpiredResponse, createTokenExpiredError } = require("../../utils/metaErrorHandler");

const FB_API_VERSION = process.env.FB_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;

function getAccessToken(req) {
  return req.header("x-fb-access-token") || process.env.FB_ACCESS_TOKEN || "";
}

async function fbRequest({ method, url, params, data, accessToken }) {
  console.log(`FB Request: ${method.toUpperCase()} ${url}`);
  console.log("Params:", { ...params, access_token: accessToken ? "REDACTED" : "N/A" });
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
  
  // Log full error details for debugging
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
  
  // Create a more detailed error message
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

exports.createCampaign = async (req, res, next) => {
  const accessToken = getAccessToken(req);

  try {
    if (!accessToken) {
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    }

    const {
      adAccountId,
      name,
      objective,
      status = "PAUSED",
      special_ad_categories, // Don't set default - only include if provided
    } = req.body || {};

    requireFields({ adAccountId, name, objective }, [
      "adAccountId",
      "name",
      "objective",
    ]);

    // Validate and format ad account ID
    let actId = String(adAccountId).trim();
    if (!actId.startsWith("act_")) {
      actId = `act_${actId}`;
    }

    // Validate objective - use Facebook's exact values (v23.0)
    // Valid objectives as per Facebook API v23.0 - OUTCOME_* format:
    const campaignObjectivesV23 = [
      "OUTCOME_AWARENESS",
      "OUTCOME_TRAFFIC",
      "OUTCOME_ENGAGEMENT",
      "OUTCOME_LEADS",
      "OUTCOME_SALES",
      "OUTCOME_APP_PROMOTION"
    ];
    
    const validObjectives = campaignObjectivesV23;

    if (!validObjectives.includes(objective)) {
      throw Object.assign(
        new Error(`Invalid objective: ${objective}. Valid objectives: ${validObjectives.join(", ")}`),
        { status: 400 }
      );
    }

    // Build minimal payload with only required fields
    const payload = {
      name: String(name).trim(),
      objective: String(objective),
      status: String(status).toUpperCase(),
    };

    // Validate status
    const validStatuses = ["ACTIVE", "PAUSED"];
    if (!validStatuses.includes(payload.status)) {
      payload.status = "PAUSED"; // Default to PAUSED if invalid
    }

    // Handle special_ad_categories - Facebook requires this parameter
    // Valid values: "HOUSING", "EMPLOYMENT", "CREDIT", "POLITICS", "ISSUES_ELECTIONS", "SOCIAL_ISSUES_ELECTIONS", "ONLINE_GAMBLING_AND_GAMING"
    // For regular campaigns (no special categories), send an empty array []
    const validCategories = [
      "HOUSING",
      "EMPLOYMENT", 
      "CREDIT",
      "POLITICS",
      "ISSUES_ELECTIONS",
      "SOCIAL_ISSUES_ELECTIONS",
      "ONLINE_GAMBLING_AND_GAMING"
    ];
    
    if (special_ad_categories && Array.isArray(special_ad_categories) && special_ad_categories.length > 0) {
      // Filter and validate provided categories
      const filtered = special_ad_categories.filter(cat => 
        cat && typeof cat === "string" && validCategories.includes(cat.toUpperCase())
      );
      if (filtered.length > 0) {
        payload.special_ad_categories = filtered.map(cat => cat.toUpperCase());
      } else {
        // If provided but invalid, use empty array
        payload.special_ad_categories = [];
      }
    } else {
      // Required parameter - use empty array for regular campaigns
      payload.special_ad_categories = [];
    }

    // Log everything for debugging
    console.log("=== Campaign Creation Request ===");
    console.log("Ad Account ID:", actId);
    console.log("Payload:", JSON.stringify(payload, null, 2));
    console.log("Payload keys:", Object.keys(payload));
    console.log("Payload values:", Object.values(payload));
    console.log("Access Token:", accessToken ? "PRESENT" : "MISSING");

    try {
      const data = await fbRequest({
        method: "post",
        url: `${FB_GRAPH_BASE}/${actId}/campaigns`,
        data: payload,
        accessToken,
      });
      
      console.log("=== Campaign Created Successfully ===");
      console.log("Response:", JSON.stringify(data, null, 2));

      // Validate response has an ID
      if (!data || !data.id) {
        throw Object.assign(
          new Error("Campaign creation succeeded but no ID returned from Facebook"),
          { status: 500 }
        );
      }

      res.status(201).json({ success: true, campaign: data });
    } catch (fbError) {
      // Re-throw to be handled by outer catch
      console.error("=== Facebook API Error in createCampaign ===");
      console.error("Error:", fbError);
      console.error("Error FB property:", fbError.fb);
      console.error("Error message:", fbError.message);
      throw fbError;
    }
  } catch (err) {
    return handleError(err, res, next);
  }
};

exports.editCampaign = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    const { campaignId } = req.params;
    requireFields({ campaignId }, ["campaignId"]);

    const updatable = ["name", "status", "objective", "special_ad_categories"];
    const body = {};
    for (const key of updatable)
      if (req.body?.[key] !== undefined) body[key] = req.body[key];

    if (!Object.keys(body).length)
      throw Object.assign(new Error("No editable fields provided"), {
        status: 400,
      });

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${campaignId}`,
      data: body,
      accessToken,
    });
    res.json({ success: true, result: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

exports.pauseCampaign = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    const { campaignId } = req.params;
    requireFields({ campaignId }, ["campaignId"]);

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${campaignId}`,
      data: { status: "PAUSED" },
      accessToken,
    });
    res.json({ success: true, result: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

exports.activateCampaign = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    const { campaignId } = req.params;
    requireFields({ campaignId }, ["campaignId"]);

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${campaignId}`,
      data: { status: "ACTIVE" },
      accessToken,
    });
    res.json({ success: true, result: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

exports.deleteCampaign = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    const { campaignId } = req.params;
    requireFields({ campaignId }, ["campaignId"]);

    const data = await fbRequest({
      method: "delete",
      url: `${FB_GRAPH_BASE}/${campaignId}`,
      accessToken,
    });
    res.json({ success: true, result: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Get All Campaigns from an Ad Account
exports.getAllCampaigns = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    const { adAccountId, limit, after } = req.query;
    requireFields({ adAccountId }, ["adAccountId"]);

    const actId = String(adAccountId).startsWith("act_")
      ? String(adAccountId)
      : `act_${adAccountId}`;

    // Build params for pagination
    const params = { 
      fields: "id,name,status,objective,effective_status,created_time,updated_time",
      limit: limit || 25 // Default to 25, Facebook's default
    };
    
    // Add pagination cursor if provided
    if (after) {
      params.after = after;
    }

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${actId}/campaigns`,
      params,
      accessToken,
    });
    res.json({ success: true, campaigns: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Get Single Campaign Details
exports.getCampaignById = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    const { campaignId } = req.params;
    requireFields({ campaignId }, ["campaignId"]);

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${campaignId}`,
      params: {
        fields: "id,name,status,objective,effective_status,daily_budget",
      },
      accessToken,
    });
    res.json({ success: true, campaign: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

exports.getAdAccounts = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/me/adaccounts`,
      params: { fields: "id,account_id,account_status,name,currency,timezone_name,timezone_offset_hours_utc,business,business_name,amount_spent,balance,spend_cap,funding_source" },
      accessToken,
    });
    res.json({ success: true, adAccounts: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Get detailed account information for a specific ad account
// This fetches directly from the ad account endpoint for accurate balance/available funds
exports.getAdAccountDetails = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  const { adAccountId } = req.params;
  
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    if (!adAccountId)
      throw Object.assign(
        new Error("Ad Account ID is required"),
        { status: 400 }
      );

    // Remove 'act_' prefix if present for the API call
    const accountId = adAccountId.startsWith('act_') 
      ? adAccountId.replace('act_', '') 
      : adAccountId;

    // Fetch detailed account information directly from the ad account endpoint
    // This gives us the most accurate balance/available funds
    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/act_${accountId}`,
      params: { 
        fields: "id,account_id,account_status,name,currency,timezone_name,timezone_offset_hours_utc,business,business_name,amount_spent,balance,spend_cap,funding_source,min_campaign_group_spend_cap,min_daily_budget,is_notifications_enabled,is_prepay_account,disable_reason" 
      },
      accessToken,
    });
    
    res.json({ success: true, account: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Get available funds (funding_source_details) for a specific ad account
// This is a lightweight endpoint that can be called frequently
exports.getAdAccountFunds = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  const { adAccountId } = req.params;
  
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    if (!adAccountId)
      throw Object.assign(
        new Error("Ad Account ID is required"),
        { status: 400 }
      );

    // Remove 'act_' prefix if present for the API call
    const accountId = adAccountId.startsWith('act_') 
      ? adAccountId.replace('act_', '') 
      : adAccountId;

    // Fetch only funding_source_details for lightweight calls
    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/act_${accountId}`,
      params: { 
        fields: "funding_source_details,id" 
      },
      accessToken,
    });
    
    res.json({ success: true, fundingSourceDetails: data.funding_source_details, accountId: data.id });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// Get ad account insights (summary / timeseries / campaign level)
// Query params:
// - adAccountId (required): act_123... or 123...
// - datePreset (optional): last_7d | last_30d | last_90d | ...
// - timeIncrement (optional): number (e.g. 1 for daily)
// - level (optional): account | campaign | adset | ad
exports.getAdAccountInsights = async (req, res, next) => {
  const accessToken = getAccessToken(req);

  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adAccountId, datePreset = "last_30d", timeIncrement, level } = req.query;
    requireFields({ adAccountId }, ["adAccountId"]);

    const actId = String(adAccountId).startsWith("act_")
      ? String(adAccountId)
      : `act_${adAccountId}`;

    const params = {
      fields: [
        // Breakdown fields (available depending on level)
        "campaign_id",
        "campaign_name",
        "adset_id",
        "adset_name",
        "ad_id",
        "ad_name",
        // Metrics
        "impressions",
        "clicks",
        "ctr",
        "spend",
        "reach",
        "frequency",
        "cpc",
        "cpm",
        "cpp",
        "actions",
        "action_values",
        "cost_per_action_type",
      ].join(","),
      date_preset: datePreset,
    };

    if (level) params.level = level;
    if (timeIncrement) params.time_increment = Number(timeIncrement);

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${actId}/insights`,
      params,
      accessToken,
    });

    res.json({ success: true, insights: data });
  } catch (err) {
    return handleError(err, res, next);
  }
};