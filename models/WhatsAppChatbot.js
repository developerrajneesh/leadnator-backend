const mongoose = require("mongoose");

// A "step" is a single bot-reply node.
// `triggers` is an array of keyword/phrase matchers that route a user message
// to this step. One step may be marked `isStart = true` — it's used when the
// user's message doesn't match any other step.
//
// `buttons[]` is Meta's interactive-button schema extended to cover CTA types:
//   • quick_reply → user taps → routes to another step (nextStepId)
//   • url         → opens a web URL
//   • phone       → initiates a phone call
//   • copy_code   → copies a coupon / code to clipboard (no-op in WA, but we
//                   persist it so the same bot spec can drive web & WA)
const buttonSchema = new mongoose.Schema(
  {
    id:          { type: String, required: true },
    kind:        { type: String, enum: ["quick_reply", "url", "phone", "copy_code"], default: "quick_reply" },
    label:       { type: String, required: true, trim: true },
    nextStepId:  { type: String, default: "" },   // for quick_reply
    url:         { type: String, default: "" },   // for url
    phone:       { type: String, default: "" },   // for phone
    code:        { type: String, default: "" },   // for copy_code
  },
  { _id: false }
);

// A single row inside a WhatsApp list-message section.
const listRowSchema = new mongoose.Schema(
  {
    id:          { type: String, required: true },
    title:       { type: String, required: true, trim: true },   // max 24 chars (Meta)
    description: { type: String, default: "", trim: true },      // max 72 chars (Meta)
    nextStepId:  { type: String, default: "" },                  // step to jump to on tap
  },
  { _id: false }
);

const listSectionSchema = new mongoose.Schema(
  {
    title: { type: String, default: "", trim: true },            // max 24 chars
    rows:  [listRowSchema],
  },
  { _id: false }
);

const stepSchema = new mongoose.Schema(
  {
    id:        { type: String, required: true },
    isStart:   { type: Boolean, default: false },
    triggers:  [{ type: String, trim: true, lowercase: true }],

    // What kind of bubble the bot sends. "text" keeps the existing free-form
    // reply behavior; other kinds switch to a richer WhatsApp Cloud API payload.
    bodyType:  { type: String, enum: ["text", "image", "video", "document", "audio", "location", "list"], default: "text" },

    message:   { type: String, default: "" },  // text body OR caption for media
    header:    { type: String, default: "" },  // 60-char interactive header
    footer:    { type: String, default: "" },  // 60-char interactive footer

    // Media payload (for image/video/document/audio).
    // Either a public URL OR a Meta media ID (from the /media/upload endpoint).
    // If both are set, mediaId wins because Meta prefers it.
    mediaUrl:      { type: String, default: "" },
    mediaId:       { type: String, default: "" },
    mediaFilename: { type: String, default: "" },   // document only
    mediaMime:     { type: String, default: "" },   // remembered so the UI can show a preview

    // Location payload
    location: {
      lat:     { type: Number, default: null },
      lng:     { type: Number, default: null },
      name:    { type: String, default: "" },
      address: { type: String, default: "" },
    },

    // Interactive list payload — sections > rows, each row routes to a step.
    list: {
      buttonText: { type: String, default: "Options" },   // main "View options" button label (max 20)
      sections:   [listSectionSchema],
    },

    // Call-to-action buttons (quick_reply / url / phone / copy_code)
    buttons:   [buttonSchema],
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    user:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name:        { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    // The WhatsApp number this bot answers on (one active bot per number).
    phoneNumberId: { type: String, default: "", index: true },
    phoneNumber:   { type: String, default: "" },   // display number, for the UI
    // "manual" = keyword/flow bot (steps). "ai" = answers from a knowledge base.
    type:        { type: String, enum: ["manual", "ai"], default: "manual" },
    status:      { type: String, enum: ["draft", "active", "paused"], default: "draft" },
    fallback:    { type: String, default: "Sorry, I didn't get that. Try one of the options above." },
    steps:       [stepSchema],

    // AI-chatbot configuration (used when type === "ai").
    ai: {
      knowledgeBase: { type: String, default: "" },   // the info the AI answers from
      greeting:      { type: String, default: "Hi 👋 How can I help you today?" },
      tone:          { type: String, enum: ["friendly", "professional", "concise"], default: "friendly" },
      // Only WhatsApp free-form-sendable CTAs:
      //   url   → a "Visit website" cta_url button (one per message)
      //   reply → a quick-reply button the customer taps (up to 3 per message)
      ctas: [{
        _id:   false,
        label: { type: String, default: "" },
        kind:  { type: String, enum: ["url", "reply"], default: "url" },
        value: { type: String, default: "" },   // URL (for kind="url")
      }],
    },
    // Runtime stats
    messagesHandled: { type: Number, default: 0 },
    lastHandledAt:   { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.user;
        return ret;
      },
    },
  }
);

module.exports = mongoose.models.WhatsAppChatbot || mongoose.model("WhatsAppChatbot", schema);
