const mongoose = require("mongoose");

// Platform-wide audit trail. One row per mutating API action (and auth events),
// written by services/activityLog.js middleware. Admin-only viewing.
const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    userEmail:    { type: String, default: "" },
    userName:     { type: String, default: "" },
    role:         { type: String, default: "" },      // admin | user | member | anonymous
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null },
    module:       { type: String, default: "", index: true },  // wa, meta, email, calendar, autopilot…
    action:       { type: String, default: "" },      // human label e.g. "Created WhatsApp template"
    method:       { type: String, default: "" },
    path:         { type: String, default: "" },
    statusCode:   { type: Number, default: 0 },
    ip:           { type: String, default: "" },
    userAgent:    { type: String, default: "" },
    ts:           { type: Date, default: Date.now, index: true },
  },
  {
    versionKey: false,
    toJSON: {
      transform: (_doc, ret) => { ret.id = ret._id?.toString(); delete ret._id; return ret; },
    },
  }
);

schema.index({ ts: -1 });

module.exports = mongoose.models.ActivityLog || mongoose.model("ActivityLog", schema);
