const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    name:        { type: String, required: true, trim: true },
    subject:     { type: String, required: true },
    body:        { type: String, required: true },
    template:    { type: mongoose.Schema.Types.ObjectId, ref: "EmailTemplate", default: null },
    senderId:    { type: String, default: "" },   // which EmailConfig.senders profile to send from
    recipients:  [{ type: mongoose.Schema.Types.ObjectId, ref: "EmailSubscriber" }],
    status:      { type: String, enum: ["draft", "scheduled", "sending", "completed", "failed"], default: "draft" },
    sent:        { type: Number, default: 0 },
    failed:      { type: Number, default: 0 },
    opens:       { type: Number, default: 0 },
    clicks:      { type: Number, default: 0 },
    log:         [{ email: String, status: String, error: String, ts: { type: Date, default: Date.now }, messageId: String, openedAt: { type: Date, default: null } }],
    scheduledAt: { type: Date },
    sentAt:      { type: Date },
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

module.exports = mongoose.models.EmailCampaign || mongoose.model("EmailCampaign", schema);
