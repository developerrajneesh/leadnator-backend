const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    name:    { type: String, default: "" },
    email:   { type: String, required: true, lowercase: true, trim: true },
    tags:    [{ type: String }],
    status:  { type: String, enum: ["active", "unsubscribed", "bounced"], default: "active" },
    source:  { type: String, default: "manual" },
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

// Unique per (user, organization, email) so the same contact can exist
// independently in each of a user's organizations.
schema.index({ user: 1, organization: 1, email: 1 }, { unique: true });

module.exports = mongoose.models.EmailSubscriber || mongoose.model("EmailSubscriber", schema);
