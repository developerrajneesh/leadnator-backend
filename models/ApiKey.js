const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name:       { type: String, required: true, trim: true },
    prefix:     { type: String, required: true },          // first chars shown in UI (e.g. "ldn_live_a8f2")
    secret:     { type: String, required: true, select: false }, // full key, returned ONCE on create
    lastUsedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.user;
        delete ret.secret;
        return ret;
      },
    },
  }
);

module.exports = mongoose.models.ApiKey || mongoose.model("ApiKey", schema);
