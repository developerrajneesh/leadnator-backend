const mongoose = require("mongoose");

// Admin-managed FAQ entry shown to all users under /support/faq.
const schema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true },
    answer:   { type: String, required: true },
    category: { type: String, default: "General" },
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

module.exports = mongoose.models.SupportFaq || mongoose.model("SupportFaq", schema);
