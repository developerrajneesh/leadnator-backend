// File: controllers/meta/ad.controller.js
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const uploadToS3 = require("../../services/s3.service");
const { v4: uuidv4 } = require("uuid");

// Helper function to decode base64 to buffer
const decodeBase64 = (dataUrl) => {
  const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error("Invalid base64 image");
  return {
    mimeType: matches[1],
    buffer: Buffer.from(matches[2], "base64"),
  };
};
const { 
  validateAdSetToCreative, 
  validateCTAForObjective,
  DESTINATION_TYPES, 
  getAllowedCTAs,
  getAllowedCTAsForObjective,
  getAllowedObjectTypes
} = require("../../utils/metaValidation");
const { isTokenExpiredResponse, createTokenExpiredError } = require("../../utils/metaErrorHandler");

const FB_API_VERSION = process.env.FB_API_VERSION || "v23.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;

function getAccessToken(req) {
  return req.header("x-fb-access-token") || process.env.FB_ACCESS_TOKEN || "";
}

async function fbRequest({ method, url, params, data, accessToken }) {
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
  
  const e = new Error(fbErr.message || "Facebook API error");
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

// Create Ad
exports.createAd = async (req, res, next) => {
  const accessToken = getAccessToken(req);

  try {
    if (!accessToken) {
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );
    }

    const {
      adsetId,
      name,
      creative,
      status = "PAUSED",
      trackingSpecs,
    } = req.body || {};

    requireFields({ adsetId, name, creative }, [
      "adsetId",
      "name",
      "creative",
    ]);

    // Validate that adsetId exists and user has access
    // Get the adset to verify it exists and get campaign info
    let campaignObjective = null;
    let promotedObject = null;
    let adsetDestinationType = null;
    let adsetOptimizationGoal = null;
    try {
      const adsetInfo = await fbRequest({
        method: "get",
        url: `${FB_GRAPH_BASE}/${adsetId}`,
        params: {
          fields: "id,name,account_id,campaign{objective},promoted_object,optimization_goal",
        },
        accessToken,
      });
      console.log("✅ AdSet verified:", adsetInfo.id);
      
      // Get campaign objective if available
      if (adsetInfo.campaign && adsetInfo.campaign.objective) {
        campaignObjective = adsetInfo.campaign.objective;
        console.log("📋 Campaign objective:", campaignObjective);
      }
      
      // Get optimization goal if available
      if (adsetInfo.optimization_goal) {
        adsetOptimizationGoal = adsetInfo.optimization_goal;
        console.log("📋 AdSet optimization_goal:", adsetOptimizationGoal);
      }
      
      // Get promoted_object if available
      if (adsetInfo.promoted_object) {
        promotedObject = adsetInfo.promoted_object;
        console.log("📋 AdSet promoted_object:", JSON.stringify(promotedObject, null, 2));
        
        // Infer destination_type from promoted_object
        if (promotedObject.object_store_url || promotedObject.app_id) {
          adsetDestinationType = DESTINATION_TYPES.APP;
        } else if (promotedObject.lead_gen_form_id) {
          adsetDestinationType = DESTINATION_TYPES.LEAD_FORM;
        } else {
          adsetDestinationType = DESTINATION_TYPES.WEBSITE;
        }
        console.log("📋 Inferred AdSet destination_type:", adsetDestinationType);
      } else {
        console.warn("⚠️ AdSet does not have a promoted_object configured.");
        // Try to infer from campaign objective
        if (campaignObjective === "APP_INSTALLS" || campaignObjective === "OUTCOME_APP_PROMOTION") {
          adsetDestinationType = DESTINATION_TYPES.APP;
        } else if (campaignObjective === "LEAD_GENERATION" || campaignObjective === "OUTCOME_LEADS") {
          adsetDestinationType = DESTINATION_TYPES.LEAD_FORM;
        } else {
          adsetDestinationType = DESTINATION_TYPES.WEBSITE; // Default
        }
        console.log("📋 Inferred AdSet destination_type from campaign objective:", adsetDestinationType);
        console.warn("⚠️ For link ads, ensure object_story_spec includes page_id and link_data with a valid link.");
        console.warn("⚠️ The adset may need a promoted_object configured, or the creative must be complete enough for Facebook to infer it.");
        
        // For messaging CTAs, we can still proceed but need to ensure page_id is in creative
        const ctaType = creative?.object_story_spec?.link_data?.call_to_action?.type;
        const isMessagingCTA = ctaType === "WHATSAPP_MESSAGE" || ctaType === "SEND_MESSAGE" || ctaType === "MESSAGE_PAGE" || ctaType === "MESSAGE_US";
        if (isMessagingCTA) {
          console.log("ℹ️ Messaging CTA detected - will use page_id from creative if available");
        }
      }
    } catch (verifyError) {
      console.error("❌ AdSet verification failed:", verifyError.message);
      throw Object.assign(
        new Error(`AdSet ${adsetId} does not exist or you don't have permission to access it. Please verify the AdSet ID.`),
        { status: 404 }
      );
    }

    const payload = {
      name,
      adset_id: adsetId,
      status,
    };

    // Handle creative - can be object_id or creative object
    if (typeof creative === "string") {
      payload.creative = { creative_id: creative };
    } else if (creative && typeof creative === "object") {
      // If creative has object_story_spec, we need to stringify nested objects
      if (creative.object_story_spec) {
        // Remove image_url from link_data if present - Meta doesn't support it directly
        // Only image_hash is supported in link_data
        const objectStorySpec = { ...creative.object_story_spec };
        
        // Validate that object_story_spec has at least page_id, link_data, video_data, or video_id
        if (!objectStorySpec.page_id && !objectStorySpec.link_data && !objectStorySpec.video_data && !objectStorySpec.video_id) {
          throw Object.assign(
            new Error("object_story_spec must include at least one of: page_id, link_data, video_data, or video_id"),
            { status: 400 }
          );
        }
        
        // Validate video optimization goals require video content
        // Optimization goals that require video: THRUPLAY, TWO_SECOND_VIDEO_VIEWS, VIDEO_VIEWS
        // Note: Meta API may also use variations like "VIDEO_VIEWS" (without underscore)
        const videoOptimizationGoals = [
          "THRUPLAY", 
          "TWO_SECOND_VIDEO_VIEWS", 
          "VIDEO_VIEWS",
          "VIDEO VIEWS", // Some variations
          "THRU_PLAY" // Alternative format
        ];
        
        if (adsetOptimizationGoal) {
          const normalizedOptimizationGoal = adsetOptimizationGoal.toUpperCase().replace(/\s+/g, "_");
          const isVideoOptimizationGoal = videoOptimizationGoals.some(goal => 
            normalizedOptimizationGoal === goal.toUpperCase().replace(/\s+/g, "_") ||
            normalizedOptimizationGoal.includes("VIDEO") && (normalizedOptimizationGoal.includes("VIEW") || normalizedOptimizationGoal.includes("THRU"))
          );
          
          if (isVideoOptimizationGoal) {
            console.log(`📹 Video optimization goal detected: ${adsetOptimizationGoal}`);
            
            // Check if creative uses video_data or video_id
            const hasVideoContent = objectStorySpec.video_data || objectStorySpec.video_id;
            const hasLinkData = objectStorySpec.link_data;
            
            if (!hasVideoContent && hasLinkData) {
              console.error(`❌ Validation failed: ${adsetOptimizationGoal} requires video content but creative uses link_data`);
              throw Object.assign(
                new Error(
                  `The ${adsetOptimizationGoal} optimization goal cannot be used with non-video posts. ` +
                  `Your AdSet is configured for video optimization, but your ad creative uses link_data (image/link ad). ` +
                  `To fix this:\n` +
                  `1. Create a video ad by using video_data or video_id in object_story_spec, OR\n` +
                  `2. Change the AdSet optimization goal to one that supports link ads (e.g., LINK_CLICKS, POST_ENGAGEMENT, etc.)`
                ),
                { status: 400 }
              );
            }
            
            if (!hasVideoContent) {
              console.error(`❌ Validation failed: ${adsetOptimizationGoal} requires video content but no video_data or video_id found`);
              throw Object.assign(
                new Error(
                  `The ${adsetOptimizationGoal} optimization goal requires video content. ` +
                  `Your ad creative must include video_data or video_id in object_story_spec. ` +
                  `Please create a video ad or change the AdSet optimization goal to one that supports non-video ads.`
                ),
                { status: 400 }
              );
            }
            
            console.log(`✅ Video optimization goal ${adsetOptimizationGoal} validated - creative uses video content`);
          }
        }
        
        // Clean up link_data based on destination type
        if (objectStorySpec.link_data) {
          // Remove image_url if present
          if (objectStorySpec.link_data.image_url) {
            console.warn("⚠️ image_url found in link_data - removing it. Meta requires image_hash instead.");
            delete objectStorySpec.link_data.image_url;
          }
          
          // Remove empty fields that might cause issues
          Object.keys(objectStorySpec.link_data).forEach(key => {
            if (objectStorySpec.link_data[key] === "" || objectStorySpec.link_data[key] === null || objectStorySpec.link_data[key] === undefined) {
              delete objectStorySpec.link_data[key];
            }
          });
          
          // Validate link based on destination type
          // For WEBSITE destination, link is required
          // For APP destination, link might be optional (app store URL) or not needed
          // For LEAD_FORM destination, link should NOT be present
          if (adsetDestinationType === DESTINATION_TYPES.LEAD_FORM) {
            // Lead form ads should not have link in link_data
            if (objectStorySpec.link_data.link) {
              console.warn("⚠️ Removing link from link_data for LEAD_FORM destination");
              delete objectStorySpec.link_data.link;
            }
            // If link_data is now empty or only has optional fields, we might want to keep it
            // but ensure it doesn't have a link
          } else if (adsetDestinationType === DESTINATION_TYPES.WEBSITE) {
            // Website ads require a link, EXCEPT for messaging CTAs
            const ctaType = objectStorySpec.link_data?.call_to_action?.type;
            const isMessagingCTA = ctaType === "WHATSAPP_MESSAGE" || 
                                  ctaType === "SEND_MESSAGE" || 
                                  ctaType === "MESSAGE_PAGE" || 
                                  ctaType === "MESSAGE_US";
            
            // Validate link requirement
            if (!objectStorySpec.link_data.link && !isMessagingCTA) {
              throw Object.assign(
                new Error("link is required in link_data for WEBSITE destination ads. Please provide a destination URL."),
                { status: 400 }
              );
            }
            
            // For messaging CTAs, link is optional
            if (isMessagingCTA && !objectStorySpec.link_data.link) {
              console.log("ℹ️ Messaging CTA detected - link is optional");
            } else if (objectStorySpec.link_data.link) {
              // Only validate link if it exists
              const link = objectStorySpec.link_data.link;
              
              // link_data.link must be a website URL (not tel:)
              // For CALL_NOW, phone number goes in call_to_action.value.link
              if (link.startsWith('tel:')) {
                throw Object.assign(
                  new Error("link_data.link must be a website URL, not a tel: URL. For CALL_NOW, phone number should be in call_to_action.value.link."),
                  { status: 400 }
                );
              }
              
              // For regular URLs, ensure they start with http/https
              if (!link.startsWith('http://') && !link.startsWith('https://')) {
                console.warn("⚠️ Invalid link URL, adding https://");
                objectStorySpec.link_data.link = `https://${link}`;
              }
              
              // Validate link URL format
              try {
                new URL(objectStorySpec.link_data.link);
              } catch (urlError) {
                throw Object.assign(
                  new Error(`Invalid link URL format: ${objectStorySpec.link_data.link}`),
                  { status: 400 }
                );
              }
            }
            
            // Validate message field (recommended for all CTAs)
            if (!objectStorySpec.link_data.message || !objectStorySpec.link_data.message.trim()) {
              console.warn("⚠️ message field is empty in link_data. Consider adding a message for better ad performance.");
            }
          } else if (adsetDestinationType === DESTINATION_TYPES.APP) {
            // App ads: link is optional, but if present should be app store URL
            if (objectStorySpec.link_data.link) {
              const link = objectStorySpec.link_data.link;
              
              // Handle tel: URLs (shouldn't happen for APP, but handle gracefully)
              if (link.startsWith('tel:')) {
                console.warn("⚠️ tel: URL in APP destination ad - this is unusual");
                // Validate tel: URL format
                const phoneNumber = link.replace('tel:', '').replace(/[^\d+]/g, '');
                if (phoneNumber.length < 10) {
                  throw Object.assign(
                    new Error(`Invalid phone number in tel: URL. Phone number must be at least 10 digits. Got: ${link}`),
                    { status: 400 }
                  );
                }
              } else {
                // Validate it's an app store URL
                const isAppStoreUrl = link.includes("apps.apple.com") || 
                                     link.includes("play.google.com");
                if (!isAppStoreUrl) {
                  console.warn("⚠️ Link in APP destination ad should be an app store URL");
                }
                
                // Ensure link is a valid URL
                if (!link.startsWith('http://') && !link.startsWith('https://')) {
                  console.warn("⚠️ Invalid link URL, adding https://");
                  objectStorySpec.link_data.link = `https://${link}`;
                }
                
                // Validate link URL format
                try {
                  new URL(objectStorySpec.link_data.link);
                } catch (urlError) {
                  throw Object.assign(
                    new Error(`Invalid link URL format: ${objectStorySpec.link_data.link}`),
                    { status: 400 }
                  );
                }
              }
            }
            // For APP ads, link_data.link is optional - app info comes from promoted_object
          } else {
            // For other destination types or unknown types, validate link if present
            if (objectStorySpec.link_data.link) {
              const link = objectStorySpec.link_data.link;
              
              // Handle tel: URLs (for CALL_NOW)
              if (link.startsWith('tel:')) {
                // Validate tel: URL format
                const phoneNumber = link.replace('tel:', '').replace(/[^\d+]/g, '');
                if (phoneNumber.length < 10) {
                  throw Object.assign(
                    new Error(`Invalid phone number in tel: URL. Phone number must be at least 10 digits. Got: ${link}`),
                    { status: 400 }
                  );
                }
                console.log("✅ Valid tel: URL:", link);
              } else {
                // Ensure link is a valid URL
                if (!link.startsWith('http://') && !link.startsWith('https://')) {
                  console.warn("⚠️ Invalid link URL, adding https://");
                  objectStorySpec.link_data.link = `https://${link}`;
                }
                
                // Validate link URL format
                try {
                  new URL(objectStorySpec.link_data.link);
                } catch (urlError) {
                  throw Object.assign(
                    new Error(`Invalid link URL format: ${objectStorySpec.link_data.link}`),
                    { status: 400 }
                  );
                }
              }
            } else {
              // If link_data exists but no link, and we don't know the destination type,
              // we should require it for safety (default to WEBSITE behavior)
              console.warn("⚠️ link_data exists but no link provided. Assuming WEBSITE destination and requiring link.");
              throw Object.assign(
                new Error("link is required in link_data. Please provide a destination URL."),
                { status: 400 }
              );
            }
          }
          
          // After validation, if link_data is empty (no meaningful fields), check if we should keep it
          // For messaging CTAs, we might want to keep link_data even without a link
          const ctaType = objectStorySpec.link_data?.call_to_action?.type;
          const isMessagingCTA = ctaType === "WHATSAPP_MESSAGE" || 
                                ctaType === "SEND_MESSAGE" || 
                                ctaType === "MESSAGE_PAGE" || 
                                ctaType === "MESSAGE_US";
          
          const hasMeaningfulFields = Object.keys(objectStorySpec.link_data).some(key => {
            const value = objectStorySpec.link_data[key];
            // call_to_action is meaningful even without a link for messaging CTAs
            if (key === "call_to_action" && isMessagingCTA) {
              return true;
            }
            // message is meaningful
            if (key === "message" && value && value.trim()) {
              return true;
            }
            return value !== undefined && value !== null && value !== "";
          });
          
          if (!hasMeaningfulFields && !isMessagingCTA) {
            console.warn("⚠️ link_data is empty after cleanup, removing it");
            delete objectStorySpec.link_data;
          } else if (isMessagingCTA && objectStorySpec.link_data.call_to_action) {
            // For messaging CTAs, keep link_data even if only call_to_action exists
            console.log("ℹ️ Keeping link_data for messaging CTA even without link");
          }
        } else if (adsetDestinationType === DESTINATION_TYPES.WEBSITE) {
          // If link_data doesn't exist but destination is WEBSITE, check:
          // 1. If video_data or video_id exists, link_data is not required
          // 2. If it's a messaging CTA, link_data is optional
          // 3. For other CTAs, link_data with link is required
          const hasVideoContent = objectStorySpec.video_data || objectStorySpec.video_id;
          const ctaType = objectStorySpec.call_to_action?.type || objectStorySpec.video_data?.call_to_action?.type;
          const isMessagingCTA = ctaType === "WHATSAPP_MESSAGE" || ctaType === "SEND_MESSAGE" || 
                                ctaType === "MESSAGE_PAGE" || ctaType === "MESSAGE_US";
          
          if (hasVideoContent) {
            // Video ads don't require link_data
            console.log("ℹ️ Video content detected - link_data is not required");
          } else if (!isMessagingCTA) {
            throw Object.assign(
              new Error("link_data with link is required for WEBSITE destination ads. Please provide a destination URL."),
              { status: 400 }
            );
          } else {
            console.log("ℹ️ Messaging CTA detected - link_data is optional");
          }
        }
        
        // Validate video_data requirements (Meta requirements)
        if (objectStorySpec.video_data) {
          // Meta requires image_hash or image_url in video_data
          if (!objectStorySpec.video_data.image_hash && !objectStorySpec.video_data.image_url) {
            throw Object.assign(
              new Error("image_hash or image_url is required in video_data for video ads. Meta requires a thumbnail image for video ads."),
              { status: 400 }
            );
          }
          
          // Meta does NOT support link in video_data (error 1443050)
          // For WEBSITE destination video ads, link must be in call_to_action.value.link, not link_data.link
          if (objectStorySpec.video_data.link) {
            console.warn("⚠️ Removing link from video_data - Meta doesn't support it. Use call_to_action.value.link instead.");
            delete objectStorySpec.video_data.link;
          }
          
          // Meta requires call_to_action.value.link for WEBSITE destination video ads (except messaging CTAs)
          if (adsetDestinationType === DESTINATION_TYPES.WEBSITE) {
            const ctaType = objectStorySpec.video_data.call_to_action?.type;
            const isMessagingCTA = ctaType === "WHATSAPP_MESSAGE" || 
                                  ctaType === "SEND_MESSAGE" || 
                                  ctaType === "MESSAGE_PAGE" || 
                                  ctaType === "MESSAGE_US";
            
            if (!isMessagingCTA) {
              // Check if link is in call_to_action.value.link
              const hasLinkInCTA = objectStorySpec.video_data.call_to_action?.value?.link;
              
              if (!hasLinkInCTA) {
                throw Object.assign(
                  new Error("call_to_action.value.link is required for WEBSITE destination video ads. Meta requires the destination URL in call_to_action.value.link (not link_data.link) for video ads."),
                  { status: 400 }
                );
              }
              
              // Validate that it's a valid URL
              const link = objectStorySpec.video_data.call_to_action.value.link;
              if (link && !link.startsWith('http://') && !link.startsWith('https://')) {
                throw Object.assign(
                  new Error(`Invalid URL format in call_to_action.value.link: ${link}. Must be a valid HTTP/HTTPS URL.`),
                  { status: 400 }
                );
              }
            }
          }
          
          console.log("✅ Video ad validated - image_hash/image_url present in video_data, call_to_action.value.link (if required) present");
        }
        
        // page_id is REQUIRED for link ads (most campaign objectives)
        // Only skip if it's a specific ad type that doesn't need it
        const requiresPageId = campaignObjective && [
          "OUTCOME_TRAFFIC",
          "OUTCOME_ENGAGEMENT", 
          "OUTCOME_LEADS",
          "OUTCOME_SALES",
          "OUTCOME_APP_PROMOTION",
          "OUTCOME_AWARENESS"
        ].includes(campaignObjective);
        
        if (!objectStorySpec.page_id) {
          if (objectStorySpec.link_data || requiresPageId) {
            throw Object.assign(
              new Error("page_id is required in object_story_spec for link ads. Please provide a valid Facebook Page ID."),
              { status: 400 }
            );
          } else {
            console.warn("⚠️ page_id not provided in object_story_spec. Some ad types may require it.");
          }
        } else if (objectStorySpec.page_id && typeof objectStorySpec.page_id !== 'string' && typeof objectStorySpec.page_id !== 'number') {
          throw Object.assign(
            new Error("page_id must be a string or number"),
            { status: 400 }
          );
        }
        
        // Validate call_to_action if provided
        if (objectStorySpec.link_data && objectStorySpec.link_data.call_to_action) {
          // Complete list of valid call_to_action types according to Meta Marketing API v23
          const validCallToActions = [
            // General/Website CTAs
            "LEARN_MORE",
            "SHOP_NOW",
            "SIGN_UP",
            "DOWNLOAD",
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
            
            // Video/Media CTAs
            "WATCH_VIDEO",
            "WATCH_MORE",
            "LISTEN_MUSIC",
            "LISTEN_NOW",
            
            // Social Engagement CTAs
            "LIKE_PAGE",
            "FOLLOW",
            "SHARE",
            "COMMENT",
            "INTERESTED",
            "EVENT_RSVP",
            
            // App CTAs
            "INSTALL_APP",
            "INSTALL_MOBILE_APP",
            "USE_APP",
            "PLAY_GAME",
            
            // Messaging CTAs
            "WHATSAPP_MESSAGE",
            "SEND_MESSAGE",
            "MESSAGE_US",
            
            // Lead Generation CTAs
            "GET_STARTED",
            "REQUEST_QUOTE",
            
            // E-commerce CTAs
            "SHOP_ON_FACEBOOK",
            "VIEW_CATALOG",
            
            // Event CTAs
            "FIND_YOUR_GROUP",
            "SEE_MORE",
            
            // Other CTAs
            "OPEN_LINK",
            "LISTEN",
            "WATCH"
          ];
          
          if (!validCallToActions.includes(objectStorySpec.link_data.call_to_action.type)) {
            throw Object.assign(
              new Error(`Invalid call_to_action type: ${objectStorySpec.link_data.call_to_action.type}. Valid types: ${validCallToActions.join(", ")}`),
              { status: 400 }
            );
          }
          
          // Validate CTA-specific required fields
          const ctaType = objectStorySpec.link_data.call_to_action.type;
          
          // CALL_NOW requires phone number in call_to_action.value.link as tel: URL
          // link_data.link must be a website URL (not tel:)
          if (ctaType === "CALL_NOW") {
            // Validate that link_data.link is a website URL (not tel:)
            if (!objectStorySpec.link_data.link || objectStorySpec.link_data.link.startsWith('tel:')) {
              throw Object.assign(
                new Error("link_data.link must be a website URL for CALL_NOW. Phone number should be in call_to_action.value.link as tel: URL."),
                { status: 400 }
              );
            }
            
            // Validate phone number in call_to_action.value.link
            if (!objectStorySpec.link_data.call_to_action.value || 
                !objectStorySpec.link_data.call_to_action.value.link) {
              throw Object.assign(
                new Error("Phone number is required for CALL_NOW call-to-action type. Please provide a phone number in call_to_action.value.link as tel: URL."),
                { status: 400 }
              );
            }
            
            const telUrl = objectStorySpec.link_data.call_to_action.value.link;
            if (!telUrl.startsWith('tel:')) {
              // Auto-fix: convert phone number to tel: URL
              const phoneNumber = telUrl.replace(/[^\d+]/g, '');
              if (phoneNumber.length < 10) {
                throw Object.assign(
                  new Error("Please enter a valid phone number. Phone number must be at least 10 digits."),
                  { status: 400 }
                );
              }
              objectStorySpec.link_data.call_to_action.value.link = `tel:${phoneNumber}`;
              console.log("ℹ️ Auto-formatted phone number as tel: URL:", objectStorySpec.link_data.call_to_action.value.link);
            } else {
              // Validate tel: URL format
              const phoneNumber = telUrl.replace('tel:', '').replace(/[^\d+]/g, '');
              if (phoneNumber.length < 10) {
                throw Object.assign(
                  new Error("Please enter a valid phone number. Phone number must be at least 10 digits."),
                  { status: 400 }
                );
              }
            }
          }
          
          // GET_DIRECTIONS - address can be in link_data.link or call_to_action.value.link
          if (ctaType === "GET_DIRECTIONS") {
            const hasLink = objectStorySpec.link_data.link && !objectStorySpec.link_data.link.startsWith('tel:');
            const hasValueLink = objectStorySpec.link_data.call_to_action.value && 
                                objectStorySpec.link_data.call_to_action.value.link;
            
            if (!hasLink && !hasValueLink) {
              throw Object.assign(
                new Error("Address is required for GET_DIRECTIONS call-to-action type. Please provide an address in link_data.link or call_to_action.value.link."),
                { status: 400 }
              );
            }
          }
        }
        
        // Validate object_story_spec against promoted_object if available
        if (promotedObject) {
          // If promoted_object has page_id, ensure object_story_spec uses the same page_id
          if (promotedObject.page_id) {
            if (!objectStorySpec.page_id) {
              console.warn(`⚠️ AdSet promoted_object has page_id (${promotedObject.page_id}), but object_story_spec doesn't. Adding it.`);
              objectStorySpec.page_id = String(promotedObject.page_id);
            } else if (String(objectStorySpec.page_id) !== String(promotedObject.page_id)) {
              console.warn(`⚠️ AdSet promoted_object page_id (${promotedObject.page_id}) doesn't match object_story_spec page_id (${objectStorySpec.page_id}). Using promoted_object page_id.`);
              objectStorySpec.page_id = String(promotedObject.page_id);
            }
          }
          
          // If promoted_object has object_store_url, ensure link_data.link matches or is compatible
          if (promotedObject.object_store_url && objectStorySpec.link_data) {
            console.log(`📋 AdSet promoted_object.object_store_url: ${promotedObject.object_store_url}`);
            // Note: The link in link_data doesn't have to match exactly, but should be related
          }
          
          // If promoted_object has pixel_id, we might need to include it in tracking_specs
          if (promotedObject.pixel_id) {
            console.log(`📋 AdSet promoted_object.pixel_id: ${promotedObject.pixel_id}`);
          }
        }
        
        // Final check: Ensure page_id is present for link ads or messaging ads
        // For messaging CTAs, page_id is still required
        const hasLinkData = objectStorySpec.link_data !== undefined && objectStorySpec.link_data !== null;
        const ctaType = objectStorySpec.link_data?.call_to_action?.type;
        const isMessagingCTA = ctaType === "WHATSAPP_MESSAGE" || 
                              ctaType === "SEND_MESSAGE" || 
                              ctaType === "MESSAGE_PAGE" || 
                              ctaType === "MESSAGE_US";
        
        // page_id is required for all ads
        if (!objectStorySpec.page_id) {
          // Try to get page_id from promoted_object if available
          if (promotedObject && promotedObject.page_id) {
            console.log(`⚠️ Adding page_id from promoted_object: ${promotedObject.page_id}`);
            objectStorySpec.page_id = String(promotedObject.page_id);
          } else {
            throw Object.assign(
              new Error("page_id is required in object_story_spec when using link_data. Please provide a valid Facebook Page ID."),
              { status: 400 }
            );
          }
        }
        
        // For messaging CTAs, ensure we have page_id even if link_data doesn't have a link
        if (isMessagingCTA && !objectStorySpec.page_id) {
          if (promotedObject && promotedObject.page_id) {
            console.log(`⚠️ Adding page_id from promoted_object for messaging CTA: ${promotedObject.page_id}`);
            objectStorySpec.page_id = String(promotedObject.page_id);
          } else {
            throw Object.assign(
              new Error("page_id is required for messaging CTAs. Please provide a valid Facebook Page ID."),
              { status: 400 }
            );
          }
        }
        
        // Validate creative against adset destination_type
        if (adsetDestinationType) {
          const creativeForValidation = {
            object_story_spec: objectStorySpec
          };
          const validation = validateAdSetToCreative(adsetDestinationType, creativeForValidation);
          if (!validation.valid) {
            // Get allowed CTAs for better error message
            const allowedCTAs = getAllowedCTAs(adsetDestinationType);
            throw Object.assign(
              new Error(`${validation.error}${allowedCTAs.length > 0 ? ` Allowed CTA types: ${allowedCTAs.join(", ")}` : ""}`),
              { status: 400 }
            );
          }
          console.log(`Creative validated against AdSet destination_type: ${adsetDestinationType}`);
        } else {
          console.warn("Could not determine AdSet destination_type. Skipping creative validation.");
        }
        
        // Validate CTA against campaign objective
        if (campaignObjective && objectStorySpec.link_data && objectStorySpec.link_data.call_to_action) {
          const ctaType = objectStorySpec.link_data.call_to_action.type;
          const ctaValidation = validateCTAForObjective(campaignObjective, ctaType);
          if (!ctaValidation.valid) {
            const allowedCTAs = getAllowedCTAsForObjective(campaignObjective);
            throw Object.assign(
              new Error(`${ctaValidation.error}${allowedCTAs.length > 0 ? ` Allowed CTA types: ${allowedCTAs.join(", ")}` : ""}`),
              { status: 400 }
            );
          }
          console.log(`CTA ${ctaType} is valid for campaign objective ${campaignObjective}`);
        }
        
        console.log("Prepared object_story_spec:", JSON.stringify(objectStorySpec, null, 2));
        
        // Store object_story_spec as object - we'll stringify it when creating form-data
        payload.creative = {
          object_story_spec: objectStorySpec,
        };
      } else {
        payload.creative = creative;
      }
    }

    if (trackingSpecs) {
      payload.tracking_specs = JSON.stringify(trackingSpecs);
    }

    console.log("📤 Creating ad with payload:", JSON.stringify(payload, null, 2));

    // Use ad account's ads endpoint instead of adset's ads endpoint for better compatibility
    // First get the ad account ID from the adset
    let adAccountId;
    try {
      const adsetInfo = await fbRequest({
        method: "get",
        url: `${FB_GRAPH_BASE}/${adsetId}`,
        params: {
          fields: "account_id",
        },
        accessToken,
      });
      adAccountId = adsetInfo.account_id;
      console.log("✅ Using ad account:", adAccountId);
    } catch (err) {
      console.warn("⚠️ Could not get ad account ID, using adset endpoint");
      adAccountId = null;
    }

    // Meta API requires form-data format for POST requests
    // Convert payload to URLSearchParams format
    const formData = new URLSearchParams();
    formData.append('name', payload.name);
    formData.append('adset_id', payload.adset_id);
    formData.append('status', payload.status);
    
    // Add creative - Meta API expects creative as a JSON string
    // object_story_spec should be an object (not stringified) within the creative JSON
    if (payload.creative) {
      if (payload.creative.object_story_spec) {
        // object_story_spec should be an object, not a string
        // The entire creative object gets stringified
        const creativeObj = {
          object_story_spec: typeof payload.creative.object_story_spec === 'string' 
            ? JSON.parse(payload.creative.object_story_spec)
            : payload.creative.object_story_spec
        };
        
        console.log("📤 Creative object to send:", JSON.stringify(creativeObj, null, 2));
        formData.append('creative', JSON.stringify(creativeObj));
      } else if (payload.creative.creative_id) {
        formData.append('creative', JSON.stringify({ creative_id: payload.creative.creative_id }));
      } else {
        formData.append('creative', JSON.stringify(payload.creative));
      }
    }
    
    if (payload.tracking_specs) {
      formData.append('tracking_specs', payload.tracking_specs);
    }

    console.log("📤 Form data:", formData.toString());
    console.log("📤 Creative payload:", JSON.stringify(payload.creative, null, 2));
    
      // Final validation before sending
      if (payload.creative && payload.creative.object_story_spec) {
        const oss = payload.creative.object_story_spec;
        console.log("📋 Final object_story_spec validation:");
        console.log("  - page_id:", oss.page_id || "MISSING");
        console.log("  - link_data:", oss.link_data ? "PRESENT" : "MISSING");
        if (oss.link_data) {
          console.log("  - link_data.link:", oss.link_data.link || "MISSING");
          console.log("  - link_data.call_to_action:", oss.link_data.call_to_action ? JSON.stringify(oss.link_data.call_to_action) : "MISSING");
          console.log("  - link_data.image_hash:", oss.link_data.image_hash || "MISSING");
          console.log("  - link_data.message:", oss.link_data.message || "MISSING");
        }
        console.log("  - promoted_object from adset:", promotedObject ? JSON.stringify(promotedObject) : "NOT AVAILABLE");
        console.log("  - campaign_objective:", campaignObjective || "NOT AVAILABLE");
        console.log("  - adset_destination_type:", adsetDestinationType || "NOT AVAILABLE");
        
        // Critical check: If adset has promoted_object with page_id, we MUST use it
        if (promotedObject && promotedObject.page_id && !oss.page_id) {
          console.log(`⚠️ Auto-fixing: Adding page_id from promoted_object: ${promotedObject.page_id}`);
          oss.page_id = String(promotedObject.page_id);
          // Update the payload
          payload.creative.object_story_spec = oss;
        }
        
        // For messaging CTAs, ensure we have all required fields
        const ctaType = oss.link_data?.call_to_action?.type;
        const isMessagingCTA = ctaType === "WHATSAPP_MESSAGE" || ctaType === "SEND_MESSAGE" || ctaType === "MESSAGE_PAGE" || ctaType === "MESSAGE_US";
        if (isMessagingCTA) {
          console.log("📱 Messaging CTA detected - ensuring proper structure");
          // Ensure page_id is set
          if (!oss.page_id && promotedObject && promotedObject.page_id) {
            console.log(`⚠️ Auto-fixing: Adding page_id for messaging CTA: ${promotedObject.page_id}`);
            oss.page_id = String(promotedObject.page_id);
            payload.creative.object_story_spec = oss;
          }
          // Ensure link_data exists
          if (!oss.link_data) {
            throw Object.assign(
              new Error("link_data is required for messaging CTAs"),
              { status: 400 }
            );
          }
          // Ensure call_to_action exists
          if (!oss.link_data.call_to_action) {
            throw Object.assign(
              new Error("call_to_action is required in link_data for messaging CTAs"),
              { status: 400 }
            );
          }
        }
      }

    // Try creating ad using ad account endpoint (more reliable)
    let data;
    try {
      if (adAccountId) {
        // Ensure act_ prefix
        const actId = String(adAccountId).startsWith("act_")
          ? String(adAccountId)
          : `act_${adAccountId}`;
        
        // Use axios directly with form-data
        const response = await axios.post(
          `${FB_GRAPH_BASE}/${actId}/ads`,
          formData.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            params: {
              access_token: accessToken,
            },
          }
        );
        data = response.data;
      } else {
        // Fallback to adset endpoint
        const response = await axios.post(
          `${FB_GRAPH_BASE}/${adsetId}/ads`,
          formData.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            params: {
              access_token: accessToken,
            },
          }
        );
        data = response.data;
      }
    } catch (createError) {
      console.error("❌ Ad creation failed");
      console.error("❌ Error message:", createError.message);
      console.error("❌ Error response:", JSON.stringify(createError.response?.data, null, 2));
      console.error("❌ Form data sent:", formData.toString());
      console.error("❌ Payload (original):", JSON.stringify(payload, null, 2));
      console.error("❌ Creative sent:", JSON.stringify(payload.creative, null, 2));
      console.error("❌ AdSet promoted_object:", promotedObject ? JSON.stringify(promotedObject, null, 2) : "NOT AVAILABLE");
      console.error("❌ Campaign objective:", campaignObjective || "NOT AVAILABLE");
      
      // Provide more detailed error message
      if (createError.response?.data?.error) {
        const fbError = createError.response.data.error;
        const errorMsg = fbError.error_user_msg || fbError.message || "Invalid parameter";
        const errorSubcode = fbError.error_subcode;
        const errorCode = fbError.code;
        
        let detailedMessage = errorMsg;
        if (errorCode) {
          detailedMessage += ` (Error Code: ${errorCode}`;
          if (errorSubcode) {
            detailedMessage += `, Subcode: ${errorSubcode}`;
          }
          detailedMessage += `)`;
        }
        
        // Add specific guidance for common errors
        if (errorMsg.includes("Invalid parameter") || errorCode === 100) {
          detailedMessage += "\n\nCommon causes:\n";
          detailedMessage += "- Missing or invalid page_id\n";
          detailedMessage += "- Invalid link URL format\n";
          detailedMessage += "- Empty required fields in link_data\n";
          detailedMessage += "- Invalid call_to_action type\n";
          detailedMessage += "- Missing required fields in object_story_spec\n";
          detailedMessage += "- AdSet missing promoted_object (check if adset has page_id in promoted_object)\n";
          detailedMessage += "- Creative structure doesn't match campaign objective";
          
          // Add specific guidance for messaging CTAs
          if (errorMsg.includes("selected object to promote") || errorMsg.includes("1885154")) {
            detailedMessage += "\n\nFor messaging CTAs (WHATSAPP_MESSAGE, SEND_MESSAGE):\n";
            detailedMessage += "- Ensure the AdSet has a promoted_object with page_id\n";
            detailedMessage += "- Ensure object_story_spec includes page_id\n";
            detailedMessage += "- Ensure link_data includes call_to_action (link is optional for messaging)\n";
            detailedMessage += "- The campaign objective should support messaging CTAs";
          }
          
          // Add specific guidance for video optimization goals
          if (errorMsg.includes("Video Views") || errorMsg.includes("1815503") || errorMsg.includes("non-video")) {
            detailedMessage += "\n\nFor video optimization goals (THRUPLAY, TWO_SECOND_VIDEO_VIEWS, VIDEO_VIEWS):\n";
            detailedMessage += "- The AdSet optimization goal requires video content\n";
            detailedMessage += "- Your ad creative must use video_data or video_id in object_story_spec\n";
            detailedMessage += "- You cannot use link_data with image_hash for video optimization goals\n";
            detailedMessage += "- Either create a video ad or change the AdSet optimization goal to one that supports link ads";
          }
          
          // Add specific guidance for video_data image_hash requirement
          if (errorMsg.includes("image_hash") || errorMsg.includes("image_url") || errorMsg.includes("1443226")) {
            detailedMessage += "\n\nFor video ads (video_data):\n";
            detailedMessage += "- Meta requires image_hash or image_url in video_data\n";
            detailedMessage += "- This image is used as a thumbnail/preview for your video ad\n";
            detailedMessage += "- Please upload an image thumbnail when creating a video ad\n";
            detailedMessage += "- The image should be at least 1200×628px for best results";
          }
          
          // Add specific guidance for video_data link requirement
          if (errorMsg.includes("website URL") || errorMsg.includes("2061015") || errorMsg.includes("call_to_action.value.link")) {
            detailedMessage += "\n\nFor video ads with WEBSITE destination:\n";
            detailedMessage += "- Meta requires the destination URL in call_to_action.value.link (not link_data.link)\n";
            detailedMessage += "- This is the destination URL where users will be directed when they click the video ad\n";
            detailedMessage += "- Please provide a valid website URL in the Destination URL field\n";
            detailedMessage += "- The URL will be automatically placed in call_to_action.value.link\n";
            detailedMessage += "- Messaging CTAs (WHATSAPP_MESSAGE, SEND_MESSAGE) don't require a link";
          }
        }
        
        throw Object.assign(
          new Error(detailedMessage),
          { status: createError.response.status || 400, fb: fbError }
        );
      }
      
      throw createError;
    }

    res.status(201).json({ success: true, ad: data });
  } catch (err) {
    next(err);
  }
};

// Update Ad
exports.updateAd = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adId } = req.params;
    requireFields({ adId }, ["adId"]);

    const updatable = ["name", "status", "creative", "tracking_specs"];

    const body = {};
    for (const key of updatable) {
      if (req.body?.[key] !== undefined) {
        if (key === "tracking_specs" && typeof req.body[key] === "object") {
          body[key] = JSON.stringify(req.body[key]);
        } else if (key === "creative" && typeof req.body[key] === "object") {
          body[key] = req.body[key];
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
      url: `${FB_GRAPH_BASE}/${adId}`,
      data: body,
      accessToken,
    });

    res.json({ success: true, result: data });
  } catch (err) {
    next(err);
  }
};

// Get All Ads
exports.getAllAds = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adsetId } = req.query;
    requireFields({ adsetId }, ["adsetId"]);

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${adsetId}/ads`,
      params: {
        fields:
          "id,name,status,effective_status,creative,adset_id,campaign_id,preview_shareable_link",
      },
      accessToken,
    });

    res.json({ success: true, ads: data });
  } catch (err) {
    next(err);
  }
};

// Get Single Ad
exports.getAdById = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adId } = req.params;
    requireFields({ adId }, ["adId"]);

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${adId}`,
      params: {
        fields:
          "id,name,status,effective_status,creative,adset_id,campaign_id,preview_shareable_link,tracking_specs",
      },
      accessToken,
    });

    res.json({ success: true, ad: data });
  } catch (err) {
    next(err);
  }
};

// Pause Ad
exports.pauseAd = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adId } = req.params;
    requireFields({ adId }, ["adId"]);

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${adId}`,
      data: { status: "PAUSED" },
      accessToken,
    });

    res.json({ success: true, result: data });
  } catch (err) {
    next(err);
  }
};

// Activate Ad
exports.activateAd = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adId } = req.params;
    requireFields({ adId }, ["adId"]);

    const data = await fbRequest({
      method: "post",
      url: `${FB_GRAPH_BASE}/${adId}`,
      data: { status: "ACTIVE" },
      accessToken,
    });

    res.json({ success: true, result: data });
  } catch (err) {
    next(err);
  }
};

// Delete Ad
exports.deleteAd = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adId } = req.params;
    requireFields({ adId }, ["adId"]);

    const data = await fbRequest({
      method: "delete",
      url: `${FB_GRAPH_BASE}/${adId}`,
      accessToken,
    });

    res.json({ success: true, result: data });
  } catch (err) {
    next(err);
  }
};

// Get Ad Insights
exports.getAdInsights = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adId } = req.params;
    const { datePreset = "last_30d", timeRange } = req.query;
    requireFields({ adId }, ["adId"]);

    // Build params for insights API
    const params = {
      fields: "impressions,clicks,ctr,spend,reach,frequency,cpc,cpp,cpm,actions,action_values",
      date_preset: datePreset,
    };

    // If timeRange is provided, use it instead of date_preset
    if (timeRange) {
      delete params.date_preset;
      params.time_range = timeRange;
    }

    const data = await fbRequest({
      method: "get",
      url: `${FB_GRAPH_BASE}/${adId}/insights`,
      params,
      accessToken,
    });

    res.json({ success: true, insights: data });
  } catch (err) {
    next(err);
  }
};

// Get Facebook Pages
exports.getPages = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    console.log("📥 Fetching Facebook pages...");
    
    // Fetch pages with pagination support
    let allPages = [];
    let nextUrl = `${FB_GRAPH_BASE}/me/accounts?fields=id,name,access_token,category&limit=100`;
    
    while (nextUrl) {
      try {
        const response = await axios.get(nextUrl, {
          params: {
            access_token: accessToken,
          },
        });
        
        console.log("📤 Pages API response:", JSON.stringify(response.data, null, 2));
        
        if (response.data && response.data.data) {
          allPages = allPages.concat(response.data.data);
          console.log(`✅ Fetched ${response.data.data.length} pages (Total: ${allPages.length})`);
          
          // Check for pagination
          if (response.data.paging && response.data.paging.next) {
            nextUrl = response.data.paging.next;
          } else {
            nextUrl = null;
          }
        } else {
          console.error("❌ Unexpected response structure:", response.data);
          // If response doesn't have data field, it might be an error or empty
          if (response.data && !response.data.error) {
            // Response might be directly an array or different structure
            if (Array.isArray(response.data)) {
              allPages = response.data;
            }
          }
          nextUrl = null;
        }
      } catch (apiError) {
        const fbError = apiError.response?.data?.error || apiError.response?.data;
        const errorCode = fbError?.code;
        const errorMessage = fbError?.message || fbError?.error_user_msg || apiError.message;
        
        console.error("❌ Error fetching pages:", errorMessage);
        console.error("❌ Error Code:", errorCode);
        console.error("❌ Full Error:", JSON.stringify(fbError, null, 2));
        
        // Return error with details
        return res.status(apiError.response?.status || 400).json({
          success: false,
          error: errorMessage,
          errorCode: errorCode,
          pages: { data: [] }, // Return empty array structure
          metaError: fbError
        });
      }
    }
    
    console.log(`✅ Total pages fetched: ${allPages.length}`);
    
    // Return in the expected format
    res.json({ 
      success: true, 
      pages: { 
        data: allPages 
      } 
    });
  } catch (err) {
    console.error("❌ getPages error:", err);
    next(err);
  }
};

// Generate redirect page with Open Graph tags for image display
exports.generateRedirectPage = (req, res) => {
  const { imageUrl, redirectUrl, title, description } = req.query;
  
  if (!imageUrl) {
    return res.status(400).send("imageUrl parameter is required");
  }
  
  const finalRedirectUrl = redirectUrl || "https://www.example.com";
  const pageTitle = title || "Redirecting...";
  const pageDescription = description || "";
  
  // Generate HTML page with Open Graph tags
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
  
  <!-- Open Graph tags for Facebook/Instagram ads -->
  <meta property="og:image" content="${imageUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="628">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:title" content="${pageTitle}">
  <meta property="og:description" content="${pageDescription}">
  <meta property="og:url" content="${finalRedirectUrl}">
  <meta property="og:type" content="website">
  
  <!-- Redirect to final URL -->
  <meta http-equiv="refresh" content="0;url=${finalRedirectUrl}">
  <script>
    window.location.href = "${finalRedirectUrl}";
  </script>
</head>
<body>
  <p>Redirecting to <a href="${finalRedirectUrl}">${finalRedirectUrl}</a>...</p>
</body>
</html>`;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};

// Upload Image and Get Image Hash
exports.uploadImage = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adAccountId, imageUrl, imageBase64 } = req.body;

    if (!adAccountId) {
      throw Object.assign(
        new Error("adAccountId is required"),
        { status: 400 }
      );
    }

    // Ensure act_ prefix
    const actId = String(adAccountId).startsWith("act_")
      ? String(adAccountId)
      : `act_${adAccountId}`;

    let imageHash = null;
    let pagePhotoId = null; // For alternative method using page photos

    // If imageBase64 is provided, save to temp file and upload using FormData (working method)
    if (imageBase64) {
      console.log("📤 Converting base64 to file and uploading to Meta API...");
      
      // Convert base64 to buffer
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      
      // Detect image format from base64 string
      const mimeMatch = imageBase64.match(/^data:image\/(\w+);base64,/);
      const imageFormat = mimeMatch ? mimeMatch[1] : 'jpeg';
      const fileName = `meta-ad-image-${uuidv4()}.${imageFormat === 'png' ? 'png' : 'jpg'}`;
      
      // Create uploads directory if it doesn't exist
      const uploadsDir = path.join(__dirname, '../../../uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      const filePath = path.join(uploadsDir, fileName);
      let uploadResponse;
      
      try {
        // Save base64 to temporary file
        fs.writeFileSync(filePath, buffer);
        console.log("✅ Image saved to temp file:", filePath);
        
        // Use FormData with file stream (working method from server.js)
        const formData = new FormData();
        formData.append("access_token", accessToken);
        formData.append("filename", fs.createReadStream(filePath));
        
        console.log("📤 Uploading to Meta API using FormData...");
        uploadResponse = await axios.post(
          `${FB_GRAPH_BASE}/${actId}/adimages`,
          formData,
          {
            headers: formData.getHeaders(),
          }
        );
        
        // Delete temp file after successful upload
        fs.unlinkSync(filePath);
        console.log("✅ Temp file deleted");
        
        console.log("📤 Meta upload response:", JSON.stringify(uploadResponse.data, null, 2));

        // Extract hash from response
        if (uploadResponse && uploadResponse.data && uploadResponse.data.images) {
          const firstImage = Object.values(uploadResponse.data.images)[0];
          imageHash = firstImage?.hash || null;
          console.log("✅ Image hash from Meta:", imageHash);
        } else if (uploadResponse && uploadResponse.data) {
          console.error("❌ Unexpected response format:", uploadResponse.data);
          throw Object.assign(
            new Error("Unexpected response format from Meta API"),
            { status: 500 }
          );
        }
      } catch (uploadError) {
        // Clean up temp file if it exists
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log("🧹 Temp file cleaned up after error");
        }
        
        // Check for token expiration first
        if (uploadError.response?.data?.error) {
          const fbError = uploadError.response.data.error;
          if (fbError.code === 190 && fbError.error_subcode === 463) {
            return handleError(createTokenExpiredError({ fb: fbError }), res, next);
          }
        }
        
        // Get the actual error from Meta API
        const fbError = uploadError.response?.data?.error || uploadError.response?.data;
        const errorCode = fbError?.code;
        const errorMessage = fbError?.message || fbError?.error_user_msg || fbError?.error_subcode || JSON.stringify(fbError) || uploadError.message;
        const errorType = fbError?.type;
        const errorSubcode = fbError?.error_subcode;
        
        console.error("❌ Upload error status:", uploadError.response?.status);
        console.error("❌ Meta API Error:", errorMessage);
        console.error("❌ Error Code:", errorCode);
        console.error("❌ Full Error:", JSON.stringify(fbError, null, 2));
        
        // Return the dynamic error from Meta
        return res.status(uploadError.response?.status || 400).json({
          success: false,
          error: errorMessage, // Use dynamic error message from Meta
          errorCode: errorCode,
          errorType: errorType,
          errorSubcode: errorSubcode,
          metaError: fbError // Include full Meta error object for debugging
        });
      }
    } else if (imageUrl) {
      // If imageUrl is provided, download it first, then use FormData (working method)
      console.log("📥 Downloading image from URL:", imageUrl);
      
      // Create uploads directory if it doesn't exist
      const uploadsDir = path.join(__dirname, '../../../uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      const fileName = `meta-ad-image-${uuidv4()}.jpg`;
      const filePath = path.join(uploadsDir, fileName);
      let uploadResponse;
      
      try {
        // Download image from URL
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imageResponse.data);
        
        // Save to temporary file
        fs.writeFileSync(filePath, buffer);
        console.log("✅ Image downloaded and saved to temp file:", filePath);
        
        // Use FormData with file stream (working method from server.js)
        const formData = new FormData();
        formData.append("access_token", accessToken);
        formData.append("filename", fs.createReadStream(filePath));
        
        console.log("📤 Uploading to Meta API using FormData...");
        uploadResponse = await axios.post(
          `${FB_GRAPH_BASE}/${actId}/adimages`,
          formData,
          {
            headers: formData.getHeaders(),
          }
        );
        
        // Delete temp file after successful upload
        fs.unlinkSync(filePath);
        console.log("✅ Temp file deleted");
        
        console.log("📤 Upload response:", JSON.stringify(uploadResponse.data, null, 2));

        if (uploadResponse.data && uploadResponse.data.images) {
          const firstImage = Object.values(uploadResponse.data.images)[0];
          imageHash = firstImage?.hash || null;
          console.log("✅ Image hash:", imageHash);
        } else {
          console.error("❌ Unexpected response format:", uploadResponse.data);
          throw Object.assign(
            new Error("Unexpected response format from Meta API"),
            { status: 500 }
          );
        }
      } catch (uploadError) {
        // Clean up temp file if it exists
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log("🧹 Temp file cleaned up after error");
        }
        
        // Get the actual error from Meta API
        const fbError = uploadError.response?.data?.error || uploadError.response?.data;
        const errorCode = fbError?.code;
        const errorMessage = fbError?.message || fbError?.error_user_msg || fbError?.error_subcode || JSON.stringify(fbError) || uploadError.message;
        const errorType = fbError?.type;
        const errorSubcode = fbError?.error_subcode;
        
        console.error("❌ Upload error:", errorMessage);
        console.error("❌ Error Code:", errorCode);
        console.error("❌ Full Error:", JSON.stringify(fbError, null, 2));
        
        // Return the dynamic error from Meta
        return res.status(uploadError.response?.status || 400).json({
          success: false,
          error: errorMessage, // Use dynamic error message from Meta
          errorCode: errorCode,
          errorType: errorType,
          errorSubcode: errorSubcode,
          metaError: fbError // Include full Meta error object for debugging
        });
      }
    } else {
      throw Object.assign(
        new Error("Either imageUrl or imageBase64 is required"),
        { status: 400 }
      );
    }

    // Return response - imageHash should always be available if we got here
    if (imageHash) {
      res.json({ success: true, imageHash });
    } else {
      // If we got here without an imageHash, something went wrong
      console.error("❌ Failed to get image hash from Meta API");
      // Try to get error from the last response if available
      const lastError = uploadResponse?.data?.error || uploadResponse?.data;
      const errorMessage = lastError?.message || lastError?.error_user_msg || "Failed to get image hash from Meta API";
      
      return res.status(400).json({ 
        success: false, 
        error: errorMessage, // Use dynamic error message if available
        errorCode: lastError?.code,
        errorType: lastError?.type,
        requiresCapability: true,
        metaError: lastError
      });
    }
  } catch (err) {
    console.error("❌ uploadImage error:", err);
    next(err);
  }
};

// Upload Video and Get Video ID
exports.uploadVideo = async (req, res, next) => {
  const accessToken = getAccessToken(req);
  try {
    if (!accessToken)
      throw Object.assign(
        new Error("Missing x-fb-access-token or FB_ACCESS_TOKEN"),
        { status: 401 }
      );

    const { adAccountId, videoUrl, videoBase64 } = req.body;

    if (!adAccountId) {
      throw Object.assign(
        new Error("adAccountId is required"),
        { status: 400 }
      );
    }

    // Ensure act_ prefix
    const actId = String(adAccountId).startsWith("act_")
      ? String(adAccountId)
      : `act_${adAccountId}`;

    let videoId = null;

    // If videoBase64 is provided, save to temp file and upload using FormData
    if (videoBase64) {
      console.log("📤 Converting base64 video to file and uploading to Meta API...");
      
      // Convert base64 to buffer
      const base64Data = videoBase64.replace(/^data:video\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      
      // Detect video format from base64 string
      const mimeMatch = videoBase64.match(/^data:video\/(\w+);base64,/);
      const videoFormat = mimeMatch ? mimeMatch[1] : 'mp4';
      const fileName = `meta-ad-video-${uuidv4()}.${videoFormat}`;
      
      // Create uploads directory if it doesn't exist
      const uploadsDir = path.join(__dirname, '../../../uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      const filePath = path.join(uploadsDir, fileName);
      let uploadResponse;
      
      try {
        // Save base64 to temporary file
        fs.writeFileSync(filePath, buffer);
        console.log("✅ Video saved to temp file:", filePath);
        
        // Use FormData with file stream for video upload
        const formData = new FormData();
        formData.append("access_token", accessToken);
        formData.append("source", fs.createReadStream(filePath));
        
        
        console.log("📤 Uploading video to Meta API using FormData...");
        uploadResponse = await axios.post(
          `${FB_GRAPH_BASE}/${actId}/advideos`,
          formData,
          {
            headers: formData.getHeaders(),
          }
        );
        
        // Delete temp file after successful upload
        fs.unlinkSync(filePath);
        console.log("✅ Temp file deleted");
        
        console.log("📤 Meta video upload response:", JSON.stringify(uploadResponse.data, null, 2));

        // Extract video ID from response
        if (uploadResponse && uploadResponse.data && uploadResponse.data.id) {
          videoId = uploadResponse.data.id;
          console.log("✅ Video ID from Meta:", videoId);
        } else if (uploadResponse && uploadResponse.data) {
          console.error("❌ Unexpected response format:", uploadResponse.data);
          throw Object.assign(
            new Error("Unexpected response format from Meta API"),
            { status: 500 }
          );
        }
      } catch (uploadError) {
        // Clean up temp file if it exists
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log("🧹 Temp file cleaned up after error");
        }
        
        // Get the actual error from Meta API
        const fbError = uploadError.response?.data?.error || uploadError.response?.data;
        const errorCode = fbError?.code;
        const errorMessage = fbError?.message || fbError?.error_user_msg || fbError?.error_subcode || JSON.stringify(fbError) || uploadError.message;
        const errorType = fbError?.type;
        const errorSubcode = fbError?.error_subcode;
        
        console.error("❌ Upload error status:", uploadError.response?.status);
        console.error("❌ Meta API Error:", errorMessage);
        console.error("❌ Error Code:", errorCode);
        console.error("❌ Full Error:", JSON.stringify(fbError, null, 2));
        
        // Return the dynamic error from Meta
        return res.status(uploadError.response?.status || 400).json({
          success: false,
          error: errorMessage,
          errorCode: errorCode,
          errorType: errorType,
          errorSubcode: errorSubcode,
          metaError: fbError
        });
      }
    } else if (videoUrl) {
      // If videoUrl is provided, download it first, then use FormData
      console.log("📥 Downloading video from URL:", videoUrl);
      
      // Create uploads directory if it doesn't exist
      const uploadsDir = path.join(__dirname, '../../../uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      // Try to detect video format from URL or default to mp4
      const urlExtension = videoUrl.split('.').pop().split('?')[0].toLowerCase();
      const videoFormat = ['mp4', 'mov', 'avi', 'mkv'].includes(urlExtension) ? urlExtension : 'mp4';
      const fileName = `meta-ad-video-${uuidv4()}.${videoFormat}`;
      const filePath = path.join(uploadsDir, fileName);
      let uploadResponse;
      
      try {
        // Download video from URL (with timeout for large files)
        const videoResponse = await axios.get(videoUrl, { 
          responseType: 'arraybuffer',
          timeout: 300000, // 5 minutes timeout for large videos
          maxContentLength: 500 * 1024 * 1024, // 500MB max
        });
        const buffer = Buffer.from(videoResponse.data);
        
        // Save to temporary file
        fs.writeFileSync(filePath, buffer);
        console.log("✅ Video downloaded and saved to temp file:", filePath);
        
        // Use FormData with file stream for video upload
        const formData = new FormData();
        formData.append("access_token", accessToken);
        formData.append("source", fs.createReadStream(filePath));
        
        
        console.log("📤 Uploading video to Meta API using FormData...");
        uploadResponse = await axios.post(
          `${FB_GRAPH_BASE}/${actId}/advideos`,
          formData,
          {
            headers: formData.getHeaders(),
            maxContentLength: 500 * 1024 * 1024, // 500MB max
            timeout: 600000, // 10 minutes timeout for upload
          }
        );
        
        // Delete temp file after successful upload
        fs.unlinkSync(filePath);
        console.log("✅ Temp file deleted");
        
        console.log("📤 Upload response:", JSON.stringify(uploadResponse.data, null, 2));

        if (uploadResponse.data && uploadResponse.data.id) {
          videoId = uploadResponse.data.id;
          console.log("✅ Video ID:", videoId);
        } else {
          console.error("❌ Unexpected response format:", uploadResponse.data);
          throw Object.assign(
            new Error("Unexpected response format from Meta API"),
            { status: 500 }
          );
        }
      } catch (uploadError) {
        // Clean up temp file if it exists
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log("🧹 Temp file cleaned up after error");
        }
        
        // Get the actual error from Meta API
        const fbError = uploadError.response?.data?.error || uploadError.response?.data;
        const errorCode = fbError?.code;
        const errorMessage = fbError?.message || fbError?.error_user_msg || fbError?.error_subcode || JSON.stringify(fbError) || uploadError.message;
        const errorType = fbError?.type;
        const errorSubcode = fbError?.error_subcode;
        
        console.error("❌ Upload error:", errorMessage);
        console.error("❌ Error Code:", errorCode);
        console.error("❌ Full Error:", JSON.stringify(fbError, null, 2));
        
        // Return the dynamic error from Meta
        return res.status(uploadError.response?.status || 400).json({
          success: false,
          error: errorMessage,
          errorCode: errorCode,
          errorType: errorType,
          errorSubcode: errorSubcode,
          metaError: fbError
        });
      }
    } else {
      throw Object.assign(
        new Error("Either videoUrl or videoBase64 is required"),
        { status: 400 }
      );
    }

    // Return response - videoId should always be available if we got here
    if (videoId) {
      res.json({ success: true, videoId });
    } else {
      // If we got here without a videoId, something went wrong
      console.error("❌ Failed to get video ID from Meta API");
      const lastError = uploadResponse?.data?.error || uploadResponse?.data;
      const errorMessage = lastError?.message || lastError?.error_user_msg || "Failed to get video ID from Meta API";
      
      return res.status(400).json({ 
        success: false, 
        error: errorMessage,
        errorCode: lastError?.code,
        errorType: lastError?.type,
        requiresCapability: true,
        metaError: lastError
      });
    }
  } catch (err) {
    console.error("❌ uploadVideo error:", err);
    next(err);
  }
};

// Upload Image to S3 and return URL
exports.uploadImageToS3 = async (req, res, next) => {
  try {
    const { imageBase64, imageUrl } = req.body;

    // If imageBase64 is provided, upload it to S3
    if (imageBase64) {
      try {
        const { mimeType, buffer } = decodeBase64(imageBase64);
        const fileExt = mimeType.split("/")[1] || "png";
        const fileName = `whatsapp-creative-${uuidv4()}.${fileExt}`;
        const uploaded = await uploadToS3(buffer, fileName, mimeType);
        
        return res.status(200).json({
          success: true,
          url: uploaded.url,
          key: uploaded.key,
        });
      } catch (err) {
        console.error("Error uploading image to S3:", err);
        return res.status(400).json({
          success: false,
          error: "Failed to upload image to S3: " + err.message,
        });
      }
    } 
    // If imageUrl is provided, download it first then upload to S3
    else if (imageUrl) {
      try {
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imageResponse.data);
        const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
        const fileExt = contentType.split("/")[1] || "jpg";
        const fileName = `whatsapp-creative-${uuidv4()}.${fileExt}`;
        const uploaded = await uploadToS3(buffer, fileName, contentType);
        
        return res.status(200).json({
          success: true,
          url: uploaded.url,
          key: uploaded.key,
        });
      } catch (err) {
        console.error("Error downloading and uploading image:", err);
        return res.status(400).json({
          success: false,
          error: "Failed to process image: " + err.message,
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        error: "Either imageBase64 or imageUrl is required",
      });
    }
  } catch (err) {
    console.error("❌ uploadImageToS3 error:", err);
    next(err);
  }
};

