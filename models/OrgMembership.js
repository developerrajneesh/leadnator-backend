const mongoose = require("mongoose");

const orgMembershipSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: ["owner", "admin", "member"], default: "owner" },
    lastAccessedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        return ret;
      },
    },
  },
);

orgMembershipSchema.index({ user: 1, organization: 1 }, { unique: true });

module.exports = mongoose.models.OrgMembership || mongoose.model("OrgMembership", orgMembershipSchema);
