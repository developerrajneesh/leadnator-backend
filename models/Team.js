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

    // Auto-assignment config. When `enabled`, new leads routed to this team
    // are round-robin distributed across `members` (empty = all active
    // members of the team). `isDefault` marks the catch-all team used when no
    // routing rule matches a new lead. `rrCursor` is the round-robin pointer.
    autoAssign: {
      enabled:   { type: Boolean, default: false },
      isDefault: { type: Boolean, default: false },
      members:   [{ type: mongoose.Schema.Types.ObjectId, ref: "TeamMember" }],
    },
    rrCursor: { type: Number, default: 0 },
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
