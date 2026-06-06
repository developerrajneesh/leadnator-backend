const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    to:        { type: String, required: true, index: true, lowercase: true, trim: true },
    subject:   { type: String, default: "" },
    html:      { type: String, default: "" },
    messageId: { type: String, default: "" },
    status:    { type: String, enum: ["sent", "failed"], default: "sent" },
    error:     { type: String, default: "" },
    ts:        { type: Date, default: Date.now },
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

schema.index({ user: 1, to: 1, ts: -1 });

module.exports = mongoose.models.EmailLog || mongoose.model("EmailLog", schema);
