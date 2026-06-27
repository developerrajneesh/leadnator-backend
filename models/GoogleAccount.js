const mongoose = require("mongoose");

// Per-user Google OAuth connection (Calendar + Meet). Tokens are select:false
// so they never leak into normal queries / API responses.
const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null, index: true },
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

// One Google connection per (user, organization) — each workspace links its own
// Google account. (Older DBs may carry a stale unique index on `user` alone;
// drop it with scripts/backfill-calendar-org.js.)
schema.index({ user: 1, organization: 1 }, { unique: true });

module.exports = mongoose.models.GoogleAccount || mongoose.model("GoogleAccount", schema);
