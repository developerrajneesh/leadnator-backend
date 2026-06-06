const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

/** Per-org Meta Ads credentials (moved off User for multi-workspace). */
const orgMetaSchema = {
  accessToken: { type: String, select: false },
  fbUserId: { type: String, default: "" },
  fbUserName: { type: String, default: "" },
  adAccountId: { type: String, default: "" },
  accounts: [{ id: String, name: String, currency: String, account_status: Number }],
  connectedAt: { type: Date },
  webhookVerifyToken: { type: String, default: "", select: false },
  pages: [{
    id: String,
    name: String,
    accessToken: { type: String, select: false },
    subscribed: { type: Boolean, default: false },
    subscribedAt: Date,
  }],
};

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    /** Workspace login — email + password for this organization only */
    loginEmail: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    password: { type: String, minlength: 6, select: false },
    phone: { type: String, default: "" },
    logoUrl: { type: String, default: "" },
    meta: orgMetaSchema,
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.password;
        if (ret.meta) delete ret.meta.accessToken;
        return ret;
      },
    },
  },
);

organizationSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  if (String(this.password).startsWith("$2")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

organizationSchema.methods.comparePassword = function (plain) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.models.Organization || mongoose.model("Organization", organizationSchema);
