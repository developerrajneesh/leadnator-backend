const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, trim: true },
    email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },
    role:     { type: String, enum: ["user", "admin"], default: "user" },
    plan:     { type: String, enum: ["Starter", "Growth", "Pro"], default: "Starter" },
    status:   { type: String, enum: ["active", "paused", "deleted"], default: "active" },
    phone:    { type: String, default: "" },
    company:  { type: String, default: "" },
    joinedAt: { type: Date, default: Date.now },
    // Password reset tokens — one-time, expire after 1 hour. Indexed for lookup.
    passwordResetToken:     { type: String, default: "", select: false, index: true },
    passwordResetExpiresAt: { type: Date, default: null, select: false },

    meta: {
      accessToken: { type: String, select: false },
      fbUserId:    { type: String, default: "" },
      fbUserName:  { type: String, default: "" },
      adAccountId: { type: String, default: "" },
      accounts:    [{ id: String, name: String, currency: String, account_status: Number }],
      connectedAt: { type: Date },
      // Lead-Ads webhook config — verify token + which Pages we route to this user.
      webhookVerifyToken: { type: String, default: "", select: false },
      // Pages this user owns/manages — auto-populated when they connect Meta.
      // The webhook uses this to route incoming leadgen events to the right user.
      pages: [{
        id:           { type: String },
        name:         { type: String },
        accessToken:  { type: String, select: false },
        subscribed:   { type: Boolean, default: false },
        subscribedAt: { type: Date },
      }],
    },
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
  }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.methods.toSafeJSON = function () {
  const o = this.toJSON();
  delete o.password;
  if (o.meta) delete o.meta.accessToken;
  return o;
};

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
