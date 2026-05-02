// Razorpay payment webhook — stub. Replace the placeholder handler when you
// wire up subscription events (payment.captured, subscription.activated, etc.).
//
// IMPORTANT: Razorpay verifies with HMAC-SHA256 over the RAW body and sends the
// signature in the `X-Razorpay-Signature` header. That means this router needs
// the raw body, NOT a parsed JSON object. We attach a raw-body parser INSIDE
// this router so the rest of the app can stay on `express.json()`.

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

// Use a raw-body parser only for this router so signature verification works.
router.use(express.raw({ type: "*/*", limit: "2mb" }));

router.post("/", (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook/razorpay] RAZORPAY_WEBHOOK_SECRET not set — rejecting");
    return res.sendStatus(503);
  }

  const signature = req.headers["x-razorpay-signature"];
  const expected  = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
  if (!signature || signature !== expected) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  let payload;
  try { payload = JSON.parse(req.body.toString("utf8")); }
  catch { return res.status(400).json({ error: "Invalid JSON" }); }

  // TODO: route on payload.event (payment.captured, subscription.activated, etc.)
  console.log("[webhook/razorpay] event:", payload.event);

  res.json({ ok: true });
});

module.exports = router;
