const mongoose = require("mongoose");

const nodeSchema = new mongoose.Schema(
  {
    id:    { type: String, required: true },
    type:  { type: String, required: true },
    title: { type: String, default: "" },
    x:     { type: Number, default: 0 },
    y:     { type: Number, default: 0 },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const edgeSchema = new mongoose.Schema(
  {
    id:       { type: String, required: true },
    fromNode: { type: String, required: true },
    fromPort: { type: String, default: "out" },
    toNode:   { type: String, required: true },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name:   { type: String, required: true, trim: true },
    status: { type: String, enum: ["draft", "active", "paused"], default: "draft" },
    nodes:  [nodeSchema],
    edges:  [edgeSchema],
    runs:   { type: Number, default: 0 },
    lastRunAt: { type: Date },
    runLog: [{
      ts:        { type: Date, default: Date.now },
      trigger:   { type: String, default: "" },
      leadName:  { type: String, default: "" },
      leadEmail: { type: String, default: "" },
      leadPhone: { type: String, default: "" },
      steps:     [{
        nodeId:    String,
        nodeType:  String,
        nodeTitle: String,
        ok:        Boolean,
        message:   String,
      }],
    }],
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

module.exports = mongoose.models.LeadFlow || mongoose.model("LeadFlow", schema);
