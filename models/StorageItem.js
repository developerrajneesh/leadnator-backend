const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    name:       { type: String, required: true, trim: true },
    type:       { type: String, enum: ["folder", "file"], required: true },
    parentPath: { type: String, default: "/", index: true },   // e.g. "/" or "/Documents/Contracts"
    path:       { type: String, default: "" },                  // computed: parentPath + "/" + name (folders only)
    ext:        { type: String, default: "" },
    mimeType:   { type: String, default: "" },
    size:       { type: Number, default: 0 },
    s3Key:      { type: String, default: "" },                  // for files: object key in the bucket
    deleted:    { type: Boolean, default: false, index: true },
    deletedAt:  { type: Date },
    sharedWith: [{ type: String }],                              // emails (simple sharing model)
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

schema.index({ user: 1, organization: 1, parentPath: 1, deleted: 1 });

module.exports = mongoose.models.StorageItem || mongoose.model("StorageItem", schema);
