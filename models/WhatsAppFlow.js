const mongoose = require("mongoose");

const nodeSchema = new mongoose.Schema(
  {
    id:    { type: String, required: true },
    type:  { type: String, required: true }, // trigger.new_lead | action.send_template | wait | condition.has_tag …
    title: { type: String, default: "" },
    x:     { type: Number, default: 0 },
    y:     { type: Number, default: 0 },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const edgeSchema = new mongoose.Schema(
  {
    id:        { type: String, required: true },
    fromNode:  { type: String, required: true },
    fromPort:  { type: String, default: "out" }, // "out", "yes", "no"
    toNode:    { type: String, required: true },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name:   { type: String, required: true, trim: true },
    status: { type: String, enum: ["draft", "active", "paused"], default: "draft" },
    nodes:  [nodeSchema],
    edges:  [edgeSchema],
    runs:   { type: Number, default: 0 },
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

schema.index({ organization: 1, user: 1, updatedAt: -1 });

module.exports = mongoose.models.WhatsAppFlow || mongoose.model("WhatsAppFlow", schema);
