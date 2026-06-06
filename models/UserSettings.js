const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },

    // Account preferences
    language:   { type: String, default: "en" },
    timezone:   { type: String, default: "Asia/Kolkata" },
    dateFormat: { type: String, default: "DD MMM YYYY" },
    currency:   { type: String, default: "INR" },
    weekStart:  { type: String, enum: ["sunday", "monday"], default: "monday" },

    // Per-user table preferences (e.g. which columns the Leads table shows).
    leadColumns: { type: [String], default: [] },
    // Which fields each pipeline (kanban) card shows.
    leadCardFields: { type: [String], default: [] },

    // Notifications
    notifications: {
      newLead:       { type: Boolean, default: true },
      campaignDone:  { type: Boolean, default: true },
      weeklyReport:  { type: Boolean, default: true },
      billingAlerts: { type: Boolean, default: true },
      productUpdates:{ type: Boolean, default: false },
    },

    // SMS / Twilio
    sms: {
      enabled:    { type: Boolean, default: false },
      provider:   { type: String, default: "twilio" },
      phone:      { type: String, default: "" },
      accountSid: { type: String, default: "", select: false },
      authToken:  { type: String, default: "", select: false },
    },

    // Bio / Profile
    bio:        { type: String, default: "" },
    website:    { type: String, default: "" },
    avatarUrl:  { type: String, default: "" },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.user;
        if (ret.sms) {
          delete ret.sms.accountSid;
          delete ret.sms.authToken;
        }
        return ret;
      },
    },
  }
);

module.exports = mongoose.models.UserSettings || mongoose.model("UserSettings", schema);
