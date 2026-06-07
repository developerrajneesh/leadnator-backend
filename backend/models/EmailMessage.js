const mongoose = require("mongoose");

// One email in a user's mailbox — inbound (received via SES webhook) or
// outbound (sent via SES from the mailbox UI). Grouped into conversations by
// `counterparty` (the other party's address).
const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },

    direction:   { type: String, enum: ["inbound", "outbound"], required: true },
    mailbox:     { type: String, default: "", index: true },   // the user's address (e.g. support@leadnator.com)
    counterparty:{ type: String, default: "", index: true },   // the other party's address (conversation key)

    fromName:    { type: String, default: "" },
    fromEmail:   { type: String, default: "" },
    toEmails:    [{ type: String }],

    subject:     { type: String, default: "" },
    text:        { type: String, default: "" },
    html:        { type: String, default: "" },

    messageId:   { type: String, default: "" },
    inReplyTo:   { type: String, default: "" },

    read:        { type: Boolean, default: false },
    ts:          { type: Date, default: Date.now, index: true },
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

schema.index({ user: 1, counterparty: 1, ts: -1 });

module.exports = mongoose.models.EmailMessage || mongoose.model("EmailMessage", schema);
