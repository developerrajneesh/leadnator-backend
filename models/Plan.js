const mongoose = require("mongoose");

const planSchema = new mongoose.Schema(
  {
    key:       { type: String, required: true, unique: true },
    name:      { type: String, required: true },
    price:     { type: Number, required: true },
    leadLimit: { type: Number, default: 0 },
    popular:   { type: Boolean, default: false },
    features:  [{ type: String }],
    disabled:  [{ type: String }],
    tagline:   { type: String, default: "" },
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

module.exports = mongoose.models.Plan || mongoose.model("Plan", planSchema);
