// Instagram webhook — DMs, comments, mentions (Meta Graph API).
// Mount: /webhooks/instagram

const express = require("express");
const router = express.Router();

router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token) {
    return res.status(200).send(challenge);
  }
  res.status(403).send("Forbidden");
});

router.post("/", express.json(), (req, res) => {
  // TODO: route events to InstagramConnection by page/ig id
  console.log("[webhook/instagram]", JSON.stringify(req.body).slice(0, 500));
  res.sendStatus(200);
});

module.exports = router;
