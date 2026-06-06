const mongoose = require("mongoose");

// Admin-managed documentation link/article grouped by category.
const schema = new mongoose.Schema(
  {
    category: { type: String, required: true, trim: true },
    title:    { type: String, required: true, trim: true },
    url:      { type: String, default: "" },  // external link (optional)
    body:     { type: String, default: "" },  // inline markdown (optional)
    published:{ type: Boolean, default: true },
    order:    { type: Number, default: 0 },
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

module.exports = mongoose.models.SupportDoc || mongoose.model("SupportDoc", schema);
