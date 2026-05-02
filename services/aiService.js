// AI service — single entry point for all AI content generation.
//
// To switch providers (Gemini ↔ OpenAI ↔ Claude ↔ local model) only this
// file needs editing. Routes import { generate, generateText } and don't
// know which provider is behind it.
//
// Env vars:
//   GEMINI_API_KEY        — required for live Gemini calls
//   GEMINI_MODEL          — default "gemini-flash-latest"
//   AI_PROVIDER           — "gemini" (default) | "openai" | "template"
//   OPENAI_API_KEY        — fallback if AI_PROVIDER=openai

const axios = require("axios");

// ---------- Provider configs ----------
const GEMINI = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  defaultModel: process.env.GEMINI_MODEL || "gemini-flash-latest",
};

// ---------- System prompts per content type ----------
const SYSTEM_PROMPTS = {
  ad:      "You write punchy, conversion-focused ad copy for B2B/SaaS. Keep it under 80 words, use emojis sparingly, end with a clear CTA.",
  email:   "You write warm, personal outreach emails. Include a subject line on the first line, keep the body under 120 words, always personal, never salesy.",
  sms:     "You write compliant SMS marketing messages under 160 characters. Include a merge field for first name and always a STOP opt-out.",
  subject: "You write 5 different email subject line options, one per line, under 8 words each, high open-rate style (curiosity, urgency, benefit).",
  whatsapp:"You write WhatsApp template body copy. Use named variables like {{customer_name}} where appropriate. Keep it conversational, under 160 characters.",
  generic: "You are a helpful marketing copywriter for an AI lead-management SaaS called Leadnator.",
};

// ---------- Template fallbacks (used if no API key configured) ----------
const TEMPLATE_FALLBACKS = {
  ad: (brief) => `🚀 ${brief.audience ? `Hey ${brief.audience},` : "Attention founders!"} ${brief.product || "Leadnator"} helps you ${brief.goal || "turn clicks into customers"}.

✅ AI-generated ad copy
✅ Meta + Google Ads leads piped in
✅ Automated drip that closes while you sleep

${brief.cta || "Start free →"} ${brief.link || "leadnator.app"}`,

  email: (brief) => `Subject: ${brief.subject || "A quick question for {{firstName}}"}

Hi {{firstName}},

${brief.context || `Noticed you showed interest in ${brief.product || "our product"}. Quick question:`}
what's the #1 thing slowing your ${brief.painPoint || "growth"} right now?

Reply with one word and I'll send a custom playbook (no pitch, promise).

— ${brief.signature || "The Leadnator team"}`,

  sms:     (brief) => `Hey {{firstName}}, ${brief.body || "quick follow-up"}. ${brief.link ? `Link: ${brief.link}` : ""} Reply STOP to opt out.`,
  subject: () => [
    "A 3-minute favour (worth ₹10k in saved time)",
    "{{firstName}}, opening this will save you hours",
    "Quick question about your marketing",
    "Don't open this unless you need more leads",
    "The one growth hack we wish we knew earlier",
  ].join("\n"),
  whatsapp: (brief) => `Hi {{customer_name}}, ${brief.body || `we have an update about ${brief.product || "your account"}`}. Reply YES to learn more.`,
  generic:  (brief) => `${brief.prompt || "Here's a quick draft you can edit."}`,
};

function fallback(type, brief = {}) {
  const fn = TEMPLATE_FALLBACKS[type] || TEMPLATE_FALLBACKS.generic;
  return fn(brief);
}

// ---------- Provider implementations ----------
async function callGemini({ system, prompt, model, temperature = 0.8 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const useModel = model || GEMINI.defaultModel;
  const url = `${GEMINI.baseUrl}/models/${useModel}:generateContent`;

  // Gemini doesn't have a separate "system" field at v1beta — prepend it.
  const fullPrompt = system ? `${system}\n\n---\n${prompt}` : prompt;

  const res = await axios.post(
    url,
    {
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: { temperature, candidateCount: 1 },
    },
    {
      headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
      validateStatus: () => true,
      timeout: 30000,
    }
  );

  if (res.status < 200 || res.status >= 300) {
    const msg = res.data?.error?.message || res.statusText || "Gemini call failed";
    const err = new Error(msg);
    err.status = res.status;
    err.provider = "gemini";
    throw err;
  }

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
  return text.trim();
}

async function callOpenAI({ system, prompt, model = "gpt-4o-mini", temperature = 0.8 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });
  const resp = await client.chat.completions.create({
    model, temperature,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
  });
  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// ---------- Public API ----------

/**
 * Pick which provider to use based on env / availability.
 * Returns "gemini" | "openai" | "template".
 */
function resolveProvider() {
  const explicit = (process.env.AI_PROVIDER || "").toLowerCase();
  if (explicit === "template") return "template";
  if (explicit === "openai" && process.env.OPENAI_API_KEY) return "openai";
  if (explicit === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.GEMINI_API_KEY) return "gemini";          // default preference
  if (process.env.OPENAI_API_KEY?.startsWith("sk-")) return "openai";
  return "template";
}

/**
 * Free-form text generation. Use for arbitrary prompts.
 *
 * @param {object} args
 * @param {string} args.prompt   Required. The user prompt.
 * @param {string} [args.system] Optional system / persona prompt.
 * @param {string} [args.model]  Optional model override (provider-specific).
 * @param {number} [args.temperature]
 * @returns {Promise<{ content: string, provider: string, model: string }>}
 */
async function generateText({ prompt, system, model, temperature } = {}) {
  if (!prompt) throw new Error("prompt required");
  const provider = resolveProvider();
  try {
    if (provider === "gemini") {
      const content = await callGemini({ prompt, system, model, temperature });
      return { content, provider, model: model || GEMINI.defaultModel };
    }
    if (provider === "openai") {
      const useModel = model || "gpt-4o-mini";
      const content = await callOpenAI({ prompt, system, model: useModel, temperature });
      return { content, provider, model: useModel };
    }
    // template
    return { content: prompt, provider: "template", model: "n/a" };
  } catch (err) {
    console.warn(`[aiService] ${provider} failed:`, err.message);
    return { content: prompt, provider: "template", model: "n/a", warning: err.message };
  }
}

/**
 * High-level helper for the marketing UI. Picks a system prompt by content
 * type, formats the brief into a user prompt, and returns generated copy.
 *
 * @param {object} args
 * @param {"ad"|"email"|"sms"|"subject"|"whatsapp"|"generic"} [args.type="ad"]
 * @param {object} [args.brief]   Free-form key/value brief (audience, product, goal, cta, link…)
 * @param {string} [args.prompt]  Optional explicit prompt that overrides the brief-built one.
 * @param {string} [args.model]   Optional model override.
 */
async function generate({ type = "ad", brief = {}, prompt, model } = {}) {
  const system = SYSTEM_PROMPTS[type] || SYSTEM_PROMPTS.generic;
  const userPrompt = prompt || `Brief:\n${JSON.stringify(brief, null, 2)}\n\nWrite the copy now.`;

  const provider = resolveProvider();
  if (provider === "template") {
    return { content: fallback(type, brief), provider: "template", model: "n/a", type };
  }

  try {
    const out = await generateText({ prompt: userPrompt, system, model });
    return { ...out, type };
  } catch (err) {
    console.warn(`[aiService.generate] falling back to template:`, err.message);
    return { content: fallback(type, brief), provider: "template", model: "n/a", type, warning: err.message };
  }
}

module.exports = {
  generate,
  generateText,
  resolveProvider,
  SYSTEM_PROMPTS,
};
