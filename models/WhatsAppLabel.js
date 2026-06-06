const mongoose = require("mongoose");

// Per-user labels (think WhatsApp Business labels / tags) that can be attached
// to contacts and filtered on in the inbox or broadcasts.
const schema = new mongoose.Schema(
  {
    user:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name:        { type: String, required: true, trim: true },
    color:       { type: String, default: "#7c3aed" },   // hex used for badge rendering
    description: { type: String, default: "", trim: true },
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

// Name must be unique per user — prevents duplicate "VIP" / "VIP" chaos.
schema.index({ user: 1, name: 1 }, { unique: true });

module.exports = mongoose.models.WhatsAppLabel || mongoose.model("WhatsAppLabel", schema);
