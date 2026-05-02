const mongoose = require("mongoose");

// A Team groups TeamMembers under one owner. Owners can create as many
// teams as they want (e.g. "Sales", "Support", "Marketing"). When a new
// member is added, they must be assigned to exactly one team.
const schema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name:  { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    color: { type: String, default: "#7c3aed" },  // badge/tag color in the UI
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.owner;
        return ret;
      },
    },
  }
);

// Name is unique within a single owner's teams (can't have two "Sales" teams).
schema.index({ owner: 1, name: 1 }, { unique: true });

module.exports = mongoose.models.Team || mongoose.model("Team", schema);
