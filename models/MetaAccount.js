const mongoose = require("mongoose");

const metaAccountSchema = new mongoose.Schema(
  {
    name:      { type: String, required: true },
    connected: { type: Boolean, default: false },
    spend:     { type: Number, default: 0 },
    leads:     { type: Number, default: 0 },
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
  }
);

module.exports = mongoose.models.MetaAccount || mongoose.model("MetaAccount", metaAccountSchema);
