const mongoose = require("mongoose");

const campaignSchema = new mongoose.Schema(
  {
    owner:   { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    name:    { type: String, required: true },
    subject: { type: String, default: "" },
    body:    { type: String, default: "" },
    status:  { type: String, enum: ["draft", "active", "paused", "completed"], default: "draft" },
    sent:    { type: Number, default: 0 },
    opens:   { type: Number, default: 0 },
    clicks:  { type: Number, default: 0 },
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

module.exports = mongoose.models.Campaign || mongoose.model("Campaign", campaignSchema);
