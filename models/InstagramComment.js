const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:          { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    mediaId:       { type: String, default: "" },
    commentId:     { type: String, required: true, index: true },
    igUserId:      { type: String, default: "" },
    igUsername:    { type: String, default: "" },
    text:          { type: String, default: "" },
    replied:       { type: Boolean, default: false },
    replyText:     { type: String, default: "" },
  },
  { timestamps: true }
);

schema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.InstagramComment || mongoose.model("InstagramComment", schema);
