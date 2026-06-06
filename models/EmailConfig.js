const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    host:       { type: String, default: "smtp.gmail.com" },
    port:       { type: Number, default: 587 },
    secure:     { type: Boolean, default: false },
    username:   { type: String, default: "" },
    password:   { type: String, default: "", select: false },
    fromName:   { type: String, default: "" },
    fromEmail:  { type: String, default: "" },
    replyTo:    { type: String, default: "" },
    verified:   { type: Boolean, default: false },
    verifiedAt: { type: Date },
    lastError:  { type: String, default: "" },

    // ---- Amazon SES domain attach (optional) ----
    sesDomain: { type: String, default: "" },
    sesDnsRecords: { type: Array, default: [] },
    sesVerified: { type: Boolean, default: false },
    sesStatus: { type: String, default: "" },
    sesLastCheckedAt: { type: Date, default: null },
    sesFromEmail: { type: String, default: "" },   // e.g. support@example.com
    sesFromName: { type: String, default: "" },

    // Signature appended to outgoing campaign emails (when enabled).
    signature: {
      enabled: { type: Boolean, default: true },   // default ON if a signature is set
      html:    { type: String,  default: "" },
      name:    { type: String,  default: "" },
      title:   { type: String,  default: "" },
      company: { type: String,  default: "" },
      email:   { type: String,  default: "" },
      phone:   { type: String,  default: "" },
      website: { type: String,  default: "" },
      avatarUrl: { type: String, default: "" },   // base64 data URL or external URL
    },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.user;
        delete ret.password;
        return ret;
      },
    },
  }
);

module.exports = mongoose.models.EmailConfig || mongoose.model("EmailConfig", schema);
