const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    contactPhone:{ type: String, required: true, index: true },
    direction:   { type: String, enum: ["outbound", "inbound"], required: true },
    type:        { type: String, default: "text" },
    text:        { type: String, default: "" },
    templateName:{ type: String, default: "" },
    messageId:   { type: String, default: "" },
    status:      { type: String, default: "sent" },
    ts:          { type: Date, default: Date.now },

    // Reference to the campaign this message belongs to (only set on
    // outbound messages created by /bulk-messages or a campaign send).
    // Inbound messages and one-off manual sends leave this null.
    campaign:    { type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppCampaign", default: null, index: true },

    // Rich-content metadata so the inbox can render buttons/media/lists that
    // the bot sent (otherwise we'd only have plain text). Shape matches what
    // the chatbot step editor produces — subset of the WhatsApp Cloud payload.
    //   { buttons:[{kind,label,url,phone,code,nextStepId}],
    //     media:{ url, id, filename, mime, kind: "image"|"video"|... },
    //     list:  { buttonText, sections:[{title, rows:[{id,title,description}]}] },
    //     location:{ lat, lng, name, address },
    //     botStepId: "...", botName: "..." }
    meta:        { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        return ret;
      },
    },
  }
);

schema.index({ user: 1, contactPhone: 1, ts: -1 });

module.exports = mongoose.models.WhatsAppMessage || mongoose.model("WhatsAppMessage", schema);
