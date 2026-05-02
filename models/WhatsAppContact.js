const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name:    { type: String, required: true, trim: true },
    phone:   { type: String, required: true, trim: true },
    email:   { type: String, default: "", trim: true },
    tags:    [{ type: String }],
    // References to per-user WhatsAppLabel docs. Stored as ObjectIds so we
    // can populate label details (name + color) in one join.
    labels:  [{ type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppLabel" }],
    notes:   { type: String, default: "" },
    optedIn: { type: Boolean, default: true },

    // Whether this phone number is reachable on WhatsApp. null = not yet
    // checked (e.g. Meta API rejected the probe), true/false = confirmed.
    // Set at contact-create time via Meta's contacts probe and kept up to
    // date as messages are exchanged (an inbound msg implies true).
    isOnWhatsapp:     { type: Boolean, default: null },
    waCheckedAt:      { type: Date,    default: null },
    waId:             { type: String,  default: "" },

    // Chatbot conversation state — remembers which step the user was on so
    // tapping a quick-reply button advances the flow instead of restarting.
    lastChatbotId:     { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppChatbot", default: null },
    lastChatbotStepId: { type: String, default: "" },
    lastChatbotAt:     { type: Date },

    // Timestamp the CRM user last opened this conversation in the inbox —
    // used to compute unread count (inbound msgs with ts > lastReadAt).
    lastReadAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.userId = ret.user?.toString();
        delete ret._id;
        delete ret.user;
        return ret;
      },
    },
  }
);

schema.index({ user: 1, phone: 1 }, { unique: true });

module.exports = mongoose.models.WhatsAppContact || mongoose.model("WhatsAppContact", schema);
