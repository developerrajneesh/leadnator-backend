// AI generation — OpenAI (falls back to a mock when key is missing, so dev works offline).

let openaiClient = null;
function getClient() {
  if (openaiClient) return openaiClient;
  if (!process.env.OPENAI_API_KEY) return null;
  const OpenAI = require("openai");
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

const SYSTEM_PROMPTS = {
  ad:    "You are a world-class direct-response copywriter. Write a punchy Meta Ads ad with a clear CTA. Keep under 120 words.",
  email: "You write high-converting cold / nurture emails. Return subject + body. Keep it under 180 words. Use merge-vars like {{firstName}}.",
  close: "You write friendly closing / follow-up messages that push for action without being pushy. Under 80 words.",
};

const MOCK = {
  ad:    "🚀 [MOCK AD] Tired of chasing leads? Leadnator's AI turns every click into a customer. Try free → leadnator.app",
  email: "Subject: [MOCK EMAIL] Quick favour — worth 3 minutes\n\nHi {{firstName}}, noticed you stopped by our pricing page. What's slowing your lead flow? Reply with 1 word and I'll send a 2-page playbook.",
  close: "[MOCK CLOSE] Hey {{firstName}} — locked in 15% off until Friday: {{upgradeLink}}. Want me to jump on a 10-min call?",
};

exports.generate = async (req, res) => {
  const { type = "ad", prompt = "", tone = "bold" } = req.body;
  if (!SYSTEM_PROMPTS[type]) return res.status(400).json({ error: "Invalid type" });

  const client = getClient();
  if (!client) {
    return res.json({ type, output: MOCK[type], mocked: true });
  }

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.8,
      messages: [
        { role: "system", content: SYSTEM_PROMPTS[type] },
        { role: "user",   content: `Tone: ${tone}\n\n${prompt}` },
      ],
    });
    res.json({ type, output: completion.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
