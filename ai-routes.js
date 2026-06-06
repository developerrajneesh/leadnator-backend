// AI content generation routes — all generation logic lives in
// services/aiService.js so providers/models can be swapped from one place.

const express = require("express");
const aiService = require("./services/aiService");

const router = express.Router();

router.post("/generate", async (req, res, next) => {
  try {
    const { type = "ad", brief = {}, prompt, model } = req.body || {};
    const result = await aiService.generate({ type, brief, prompt, model });
    res.json(result);
  } catch (err) { next(err); }
});

router.post("/text", async (req, res, next) => {
  try {
    const { prompt, system, model, temperature } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt required" });
    const result = await aiService.generateText({ prompt, system, model, temperature });
    res.json(result);
  } catch (err) {
    const msg = err.message || "AI generation failed";
    console.warn("[ai] /text:", msg);
    res.status(503).json({ error: msg });
  }
});

router.get("/status", (_req, res) => {
  const provider = aiService.resolveProvider();
  res.json({
    provider,
    aiEnabled: provider !== "template",
    model:
      provider === "gemini" ? (process.env.GEMINI_MODEL || "gemini-flash-latest")
      : provider === "openai" ? "gpt-4o-mini"
      : "n/a",
  });
});

module.exports = router;
