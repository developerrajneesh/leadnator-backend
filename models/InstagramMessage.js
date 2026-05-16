const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:           { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    igUserId:       { type: String, default: "" },
    igUsername:     { type: String, default: "" },
    direction:      { type: String, enum: ["in", "out"], default: "in" },
    text:           { type: String, default: "" },
    metaMessageId:  { type: String, default: "", sparse: true },
    read:           { type: Boolean, default: false },
  },
  { timestamps: true }
);

schema.index({ user: 1, conversationId: 1, createdAt: -1 });

module.exports = mongoose.models.InstagramMessage || mongoose.model("InstagramMessage", schema);
