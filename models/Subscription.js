const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema(
  {
    user:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planKey:    { type: String, enum: ["starter", "growth", "pro"], required: true },
    planName:   { type: String, required: true },
    duration:   { type: String, enum: ["monthly", "quarter", "half", "yearly"], required: true },
    months:     { type: Number, required: true },
    amount:     { type: Number, required: true }, // total in INR (rupees)
    status:     { type: String, enum: ["pending", "active", "cancelled", "expired"], default: "pending", index: true },

    // Razorpay refs
    razorpayOrderId:    { type: String, default: "" },
    razorpayPaymentId:  { type: String, default: "" },
    razorpaySignature:  { type: String, default: "" },

    startedAt:  { type: Date, default: Date.now },
    expiresAt:  { type: Date },
    cancelledAt:{ type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.razorpaySignature;
        return ret;
      },
    },
  }
);

module.exports = mongoose.models.Subscription || mongoose.model("Subscription", subscriptionSchema);
