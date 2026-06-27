const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    name:    { type: String, required: true, trim: true },
    subject: { type: String, required: true },
    body:    { type: String, required: true },     // HTML or plain text with {{vars}}
    category:{ type: String, default: "general" },
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

module.exports = mongoose.models.EmailTemplate || mongoose.model("EmailTemplate", schema);
