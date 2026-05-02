const mongoose = require("mongoose");

const invoiceSchema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", default: null },
    number:       { type: String, required: true, unique: true },
    planName:     { type: String, default: "" },
    duration:     { type: String, default: "" },
    amount:       { type: Number, required: true },
    currency:     { type: String, default: "INR" },
    status:       { type: String, enum: ["paid", "failed", "refunded"], default: "paid" },
    razorpayPaymentId: { type: String, default: "" },
    paidAt:       { type: Date, default: Date.now },
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

module.exports = mongoose.models.Invoice || mongoose.model("Invoice", invoiceSchema);
