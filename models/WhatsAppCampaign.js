const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name:         { type: String, required: true, trim: true },
    templateName: { type: String, default: "" },
    templateLang: { type: String, default: "en_US" },
    contacts:     [{ type: mongoose.Schema.Types.ObjectId, ref: "WhatsAppContact" }],
    status:       { type: String, enum: ["draft", "queued", "sending", "completed", "failed"], default: "draft" },
    sent:         { type: Number, default: 0 },
    delivered:    { type: Number, default: 0 },
    read:         { type: Number, default: 0 },
    failed:       { type: Number, default: 0 },
    log:          [{ phone: String, status: String, error: String, ts: { type: Date, default: Date.now }, messageId: String }],
  },
  {
    timestamps: true,
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

module.exports = mongoose.models.WhatsAppCampaign || mongoose.model("WhatsAppCampaign", schema);
