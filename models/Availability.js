const mongoose = require("mongoose");

const slotSchema = new mongoose.Schema(
  { day: Number, enabled: Boolean, start: String, end: String },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    user:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    timezone:  { type: String, default: "Asia/Kolkata" },
    slots:     [slotSchema],
    buffer:    { type: Number, default: 15 },
    minNotice: { type: Number, default: 60 },
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

module.exports = mongoose.models.Availability || mongoose.model("Availability", schema);
