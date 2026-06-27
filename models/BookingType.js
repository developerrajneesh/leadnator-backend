const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    name:        { type: String, required: true, trim: true },
    duration:    { type: Number, default: 30 },
    location:    { type: String, default: "Google Meet" },
    description: { type: String, default: "" },
    color:       { type: String, default: "#7c3aed" },
    slug:        { type: String, default: "" },
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

module.exports = mongoose.models.BookingType || mongoose.model("BookingType", schema);
