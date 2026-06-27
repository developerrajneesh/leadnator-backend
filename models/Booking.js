const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    bookingType:  { type: mongoose.Schema.Types.ObjectId, ref: "BookingType", required: true, index: true },
    host:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    slot:         { type: Date, required: true, index: true },
    duration:     { type: Number, required: true },
    name:         { type: String, required: true, trim: true },
    email:        { type: String, required: true, trim: true, lowercase: true },
    phone:        { type: String, default: "" },
    notes:        { type: String, default: "" },
    status:       { type: String, enum: ["confirmed", "cancelled"], default: "confirmed" },
    meetLink:      { type: String, default: "" },
    googleEventId: { type: String, default: "" },
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

schema.index({ bookingType: 1, slot: 1 }, { unique: true });

module.exports = mongoose.models.Booking || mongoose.model("Booking", schema);
