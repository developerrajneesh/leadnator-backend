const mongoose = require("mongoose");

// Per-user toggles for automatic lead creation from external sources.
// Consumed by:
//   • webhooks/facebook.js  → metaForms.enabled gates Meta Lead Ads ingest
//   • webhooks/whatsapp.js  → whatsapp.enabled auto-creates a Lead on the
//                             first inbound message from an unknown number
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },

    metaForms: {
      enabled:       { type: Boolean, default: true },
      defaultStatus: { type: String, enum: ["new", "contacted", "hot", "qualified"], default: "new" },
      defaultValue:  { type: Number, default: 0 },
      defaultTags:   [{ type: String }],
    },

    whatsapp: {
      // Auto-create a Lead when an unknown WhatsApp number messages in.
      enabled:         { type: Boolean, default: false },
      // If true, only the FIRST inbound message creates a lead. If false,
      // we still only create once-per-number (unique phone) but it can
      // happen on any inbound event.
      firstMessageOnly:{ type: Boolean, default: true },
      defaultStatus:   { type: String, enum: ["new", "contacted", "hot", "qualified"], default: "new" },
      defaultValue:    { type: Number, default: 0 },
      defaultTags:     [{ type: String, default: "whatsapp" }],
    },

    // Future integrations drop in here with their own sub-object.
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

// Default-doc helper: many callers want "get or defaults" in one step.
schema.statics.forUser = async function (userId) {
  let doc = await this.findOne({ user: userId });
  if (!doc) doc = await this.create({ user: userId });
  return doc;
};

module.exports = mongoose.models.LeadSettings || mongoose.model("LeadSettings", schema);
