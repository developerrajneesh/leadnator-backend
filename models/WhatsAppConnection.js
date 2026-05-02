const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:               { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    phoneNumberId:      { type: String, required: true },
    accessToken:        { type: String, required: true, select: false },
    businessAccountId:  { type: String, default: "" },   // WABA ID
    webhookVerifyToken: { type: String, default: "", select: false },
    displayName:        { type: String, default: "" },
    verifiedName:       { type: String, default: "" },
    phoneNumber:        { type: String, default: "" },
    quality:            { type: String, default: "" },
    connectedAt:        { type: Date, default: Date.now },

    // ---- Cached Meta Graph details (refreshed on /account-info) ----
    // Keeping these in the DB lets the Settings page render instantly
    // from the last good snapshot even if Meta rate-limits us or the
    // token temporarily loses a permission.
    wabaName:                   { type: String, default: "" },
    wabaCurrency:               { type: String, default: "" },
    wabaTimezoneId:             { type: String, default: "" },
    wabaBusinessVerification:   { type: String, default: "" },
    wabaTemplateNamespace:      { type: String, default: "" },
    businessId:                 { type: String, default: "" },
    businessName:               { type: String, default: "" },

    phoneCodeVerification:      { type: String, default: "" },
    phoneNameStatus:            { type: String, default: "" },
    phonePlatformType:          { type: String, default: "" },
    phoneThroughputLevel:       { type: String, default: "" },
    phoneMessagingLimitTier:    { type: String, default: "" },
    phoneAccountMode:           { type: String, default: "" },
    phoneIsOfficial:            { type: Boolean, default: false },
    phoneStatus:                { type: String, default: "" },

    infoRefreshedAt:            { type: Date, default: null },
    lastInfoWarnings:           [{ field: String, message: String }],
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.accessToken;
        delete ret.webhookVerifyToken;
        return ret;
      },
    },
  }
);

module.exports = mongoose.models.WhatsAppConnection || mongoose.model("WhatsAppConnection", schema);
