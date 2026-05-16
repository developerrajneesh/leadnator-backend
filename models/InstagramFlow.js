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
    trigger: { type: String, enum: ["dm.received", "comment.new", "story.mention", "keyword.dm"], default: "dm.received" },
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

module.exports = mongoose.models.InstagramFlow || mongoose.model("InstagramFlow", schema);
