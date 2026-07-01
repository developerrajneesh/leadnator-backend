const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:              { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization:      { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    igAccountId:       { type: String, required: true },
    // Instagram-Login returns a separate `user_id` (the value webhooks send as
    // entry.id), which can differ from igAccountId. Stored so webhooks can match.
    igUserId:          { type: String, default: "", index: true },
    username:          { type: String, default: "" },
    name:              { type: String, default: "" },
    profilePictureUrl: { type: String, default: "" },
    pageId:            { type: String, default: "" },
    pageName:          { type: String, default: "" },
    pageAccessToken:   { type: String, default: "", select: false },
    tokenExpiresAt:    { type: Date, default: null },
    isLongLived:       { type: Boolean, default: false },
    authMethod:        { type: String, enum: ["oauth", "facebook_page"], default: "oauth" },
    connectedAt:       { type: Date, default: Date.now },
    settings: {
      dmAutoReply:        { type: Boolean, default: false },
      dmAutoReplyText:    { type: String, default: "Thanks for your message! We'll get back to you shortly." },
      commentAutoReply:   { type: Boolean, default: false },
      commentReplyText:   { type: String, default: "Thanks for commenting! Check your DMs." },
      storyMentionNotify: { type: Boolean, default: true },
    },
    webhookVerifyToken: { type: String, default: "", select: false },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.pageAccessToken;
        delete ret.webhookVerifyToken;
        return ret;
      },
    },
  }
);

schema.index({ organization: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.InstagramConnection || mongoose.model("InstagramConnection", schema);
