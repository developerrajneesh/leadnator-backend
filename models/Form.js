const mongoose = require("mongoose");

const submissionSchema = new mongoose.Schema(
  {
    _id:    false,
    values: { type: mongoose.Schema.Types.Mixed, default: {} },
    at:     { type: Date, default: Date.now },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    formId:       { type: String, required: true, unique: true, index: true },
    title:        { type: String, default: "Untitled form" },
    description:  { type: String, default: "" },
    submitLabel:  { type: String, default: "Submit" },
    style:        { type: mongoose.Schema.Types.Mixed, default: {} },
    fields:       { type: [mongoose.Schema.Types.Mixed], default: [] },
    submissions:  { type: [submissionSchema], default: [] },
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

module.exports = mongoose.models.Form || mongoose.model("Form", schema);
