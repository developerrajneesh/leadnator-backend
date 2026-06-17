// Meta Ads campaign-builder routes — ported from the LCM project so Leadnator's
// Meta campaign creation matches it 1:1 (Campaign → Ad Set → Ad/Creative) with
// the full field set: rich targeting, interests/geo search, video upload, bid
// strategy/ROAS, promoted_object variants, etc.
//
// The LCM controllers read the FB token from the `x-fb-access-token` header.
// Leadnator stores it server-side (organization/user .meta.accessToken), so we
// resolve it and inject the header here — the controllers run unchanged.

const express = require("express");
const Organization = require("./models/Organization");
const User = require("./models/User");
const { tenantId } = require("./middleware/tenant");

const campaign = require("./controllers/metaAds/campaign.controller");
const adset = require("./controllers/metaAds/adset.controller");
const ad = require("./controllers/metaAds/ad.controller");

// Goal-specific flows (Click to WhatsApp / Call / Website / Lead Form).
const clickToCall = require("./metaapi/routes/clickToCall");
const clickToWhatsApp = require("./metaapi/routes/clickToWhatsApp");
const clickToLink = require("./metaapi/routes/clickToLink");
const clickToLeadForm = require("./metaapi/routes/clickToLeadForm");

// Resolve the user's stored Meta access token (server-side).
async function resolveToken(req) {
  let token = req.organization?.meta?.accessToken || req.user?.meta?.accessToken || "";
  if (!token) {
    const org = await Organization.findById(tenantId(req)).select("+meta.accessToken");
    token = org?.meta?.accessToken || "";
    if (!token) {
      const u = await User.findById(req.user._id).select("+meta.accessToken");
      token = u?.meta?.accessToken || "";
    }
  }
  return token;
}

// For the LCM campaign/adset/ad controllers (read token from header).
async function injectFbToken(req, res, next) {
  try {
    const token = await resolveToken(req);
    if (!token) return res.status(401).json({ error: "Meta account not connected", code: "META_NOT_CONNECTED" });
    req.headers["x-fb-access-token"] = token;
    next();
  } catch (e) { next(e); }
}

// For the click-to-* goal flows (read fb_token from body/query).
async function injectBodyToken(req, res, next) {
  try {
    const token = await resolveToken(req);
    if (!token) return res.status(401).json({ error: "Meta account not connected", code: "META_NOT_CONNECTED" });
    req.body = req.body || {};
    req.body.fb_token = token;
    req.query.fb_token = token;
    next();
  } catch (e) { next(e); }
}

const router = express.Router();

// Click-to-* goal flows (token injected into body).
router.use("/click-to-call", injectBodyToken, clickToCall);
router.use("/click-to-whatsapp", injectBodyToken, clickToWhatsApp);
router.use("/click-to-link", injectBodyToken, clickToLink);
router.use("/click-to-lead-form", injectBodyToken, clickToLeadForm);

// Generic campaign/adset/ad management (token injected into header).
router.use(injectFbToken);

// ---------------- Campaigns ----------------
const campaigns = express.Router();
campaigns.post("/", campaign.createCampaign);
campaigns.patch("/:campaignId", campaign.editCampaign);
campaigns.post("/:campaignId/pause", campaign.pauseCampaign);
campaigns.post("/:campaignId/activate", campaign.activateCampaign);
campaigns.delete("/:campaignId", campaign.deleteCampaign);
campaigns.get("/all", campaign.getAllCampaigns);
campaigns.get("/account/:adAccountId", campaign.getAdAccountDetails);
campaigns.get("/account/:adAccountId/funds", campaign.getAdAccountFunds);
campaigns.get("/insights", campaign.getAdAccountInsights);
campaigns.get("/:campaignId", campaign.getCampaignById);
campaigns.get("/", campaign.getAdAccounts);
router.use("/campaigns", campaigns);

// ---------------- Ad Sets ----------------
const adsets = express.Router();
adsets.post("/", adset.createAdSet);
adsets.patch("/:adsetId", adset.updateAdSet);
adsets.get("/all", adset.getAllAdSets);
adsets.get("/validation-info", adset.getValidationInfo);
adsets.get("/targeting-search", adset.getTargetingSearch);
adsets.get("/search-geolocation", adset.searchAdGeolocation);
adsets.get("/whatsapp/waba", adset.getWhatsAppBusinessAccounts);
adsets.get("/whatsapp/waba/:wabaId/phone-numbers", adset.getWhatsAppPhoneNumbers);
adsets.post("/whatsapp/waba/verify-phone", adset.verifyWhatsAppPhoneNumber);
adsets.get("/:adsetId", adset.getAdSetById);
adsets.post("/:adsetId/pause", adset.pauseAdSet);
adsets.post("/:adsetId/activate", adset.activateAdSet);
adsets.delete("/:adsetId", adset.deleteAdSet);
router.use("/adsets", adsets);

// ---------------- Ads ----------------
const ads = express.Router();
ads.post("/", ad.createAd);
ads.patch("/:adId", ad.updateAd);
ads.get("/all", ad.getAllAds);
ads.get("/pages", ad.getPages);
ads.post("/upload-image", ad.uploadImage);
ads.post("/upload-video", ad.uploadVideo);
ads.post("/upload-image-s3", ad.uploadImageToS3);
ads.get("/redirect-page", ad.generateRedirectPage);
ads.get("/:adId", ad.getAdById);
ads.get("/:adId/insights", ad.getAdInsights);
ads.post("/:adId/pause", ad.pauseAd);
ads.post("/:adId/activate", ad.activateAd);
ads.delete("/:adId", ad.deleteAd);
router.use("/ads", ads);

module.exports = router;
