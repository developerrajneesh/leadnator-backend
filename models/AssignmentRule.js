const mongoose = require("mongoose");

// A lead-routing rule. When a new lead arrives it is matched against the
// owner's enabled rules in `priority` order (ascending). The first rule whose
// filters all match wins, and the lead is round-robin assigned to that rule's
// team. Empty `matchSource` / `matchTag` mean "any" for that dimension.
//
// Example: { matchSource: "Meta", team: <Sales> }  → every Meta lead goes to
// the Sales team's round-robin. { matchTag: "vip", team: <Closers> }.
const schema = new mongoose.Schema(
  {
    owner:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null, index: true },

    priority: { type: Number, default: 0 },        // lower runs first
    matchSource: { type: String, default: "", trim: true },  // "" = any source
    matchTag:    { type: String, default: "", trim: true },  // "" = any tag

    team:    { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
    enabled: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.team = ret.team ? ret.team.toString() : null;
        delete ret._id;
        delete ret.owner;
        delete ret.organization;
        return ret;
      },
    },
  }
);

schema.index({ owner: 1, priority: 1 });

module.exports = mongoose.models.AssignmentRule || mongoose.model("AssignmentRule", schema);
