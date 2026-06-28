const mongoose = require("mongoose");

// Admin-editable system-email templates. Defaults live in config/systemEmails.js;
// a row here overrides the default for that `key`.
const schema = new mongoose.Schema(
  {
    key:         { type: String, required: true, unique: true, index: true },
    name:        { type: String, default: "" },
    description: { type: String, default: "" },
    subject:     { type: String, required: true },
    html:        { type: String, required: true },
    enabled:     { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => { ret.id = ret._id?.toString(); delete ret._id; return ret; },
    },
  }
);

module.exports = mongoose.models.SystemEmailTemplate || mongoose.model("SystemEmailTemplate", schema);
