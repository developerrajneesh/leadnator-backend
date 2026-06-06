// Central mount point for every third-party webhook in the app.
//
// Pattern:
//   1. Create a new file in this folder per service (e.g. whatsapp.js, razorpay.js,
//      stripe.js, meta-ads.js). Each file exports an Express Router.
//   2. Require it below and register it here with a clear URL prefix.
//   3. Webhooks get their OWN body parser if they need the raw body for signature
//      verification (Razorpay/Stripe/Meta all do HMAC over the raw payload). Mount
//      this router BEFORE the global `express.json()` in server.js, OR have the
//      individual webhook file attach `express.raw({ type: '*/*' })` to its routes.
//
// Public URL:  https://<your-host>/webhooks/<service>
// Example URLs you'd paste into provider dashboards:
//     Meta WhatsApp:  https://crm.yourdomain.com/webhooks/whatsapp
//     Razorpay:       https://crm.yourdomain.com/webhooks/razorpay
//
// KEEP THIS FILE TINY — it's a router, not a handler. Real logic lives per-service.

const express = require("express");
const router = express.Router();

const whatsapp = require("./whatsapp");
const razorpay = require("./razorpay");
const facebook = require("./facebook");
const instagram = require("./instagram");
const autopilot = require("./autopilot");

router.use("/whatsapp", whatsapp);
router.use("/razorpay", razorpay);
router.use("/facebook", facebook);
router.use("/instagram", instagram);
router.use("/autopilot", autopilot);

// Health probe so uptime monitors can ping /webhooks and get a quick 200.
router.get("/", (_req, res) => res.json({ ok: true, service: "webhooks", mounted: ["whatsapp", "razorpay", "facebook", "instagram"] }));

module.exports = router;
