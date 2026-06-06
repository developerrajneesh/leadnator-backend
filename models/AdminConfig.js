const mongoose = require("mongoose");

// Singleton (key:"global") for platform-wide admin configuration.
// The master password lets an admin sign into any account for support/debugging.
// It's stored bcrypt-hashed and select:false so it never leaves the server.
const schema = new mongoose.Schema(
  {
    key:                     { type: String, default: "global", unique: true, index: true },
    masterPasswordHash:      { type: String, default: "", select: false },
    masterPasswordEnabled:   { type: Boolean, default: false },
    masterPasswordUpdatedAt: { type: Date },
    updatedBy:               { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    lastMasterLoginAt:       { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.models.AdminConfig || mongoose.model("AdminConfig", schema);
