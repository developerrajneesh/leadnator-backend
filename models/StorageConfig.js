const mongoose = require("mongoose");

// Per-user S3-compatible storage credentials (Supabase / AWS / Cloudflare R2 /
// Wasabi). Secrets are `select: false` so they never leak into plain finds or
// JSON responses. The user must explicitly opt in via the Storage settings UI.
const schema = new mongoose.Schema(
  {
    user:            { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization:    { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    endpointUrl:     { type: String, default: "" },
    accessKeyId:     { type: String, default: "", select: false },
    secretAccessKey: { type: String, default: "", select: false },
    bucketName:      { type: String, default: "" },
    region:          { type: String, default: "ap-south-1" },
    // Health snapshot — updated on Verify.
    verified:        { type: Boolean, default: false },
    verifiedAt:      { type: Date },
    lastError:       { type: String, default: "" },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.user;
        delete ret.accessKeyId;
        delete ret.secretAccessKey;
        return ret;
      },
    },
  }
);

// One storage config per (user, organization) — each workspace connects its
// own bucket. (Older DBs may carry a stale unique index on `user` alone; drop
// it with scripts/backfill-storage-org.js.)
schema.index({ user: 1, organization: 1 }, { unique: true });

module.exports = mongoose.models.StorageConfig || mongoose.model("StorageConfig", schema);
