const mongoose = require("mongoose");

// Per-user Google OAuth connection (Calendar + Meet). Tokens are select:false
// so they never leak into normal queries / API responses.
const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null },
    email:        { type: String, default: "" },
    accessToken:  { type: String, select: false },
    refreshToken: { type: String, select: false },
    scope:        { type: String, default: "" },
    tokenType:    { type: String, default: "Bearer" },
    expiryDate:   { type: Date },
    calendarId:   { type: String, default: "primary" },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.accessToken;
        delete ret.refreshToken;
        return ret;
      },
    },
  }
);

module.exports = mongoose.models.GoogleAccount || mongoose.model("GoogleAccount", schema);
