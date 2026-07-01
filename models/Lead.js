const mongoose = require("mongoose");

const leadSchema = new mongoose.Schema(
  {
    owner:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
    name:   { type: String, trim: true, default: "" },
    email:  { type: String, lowercase: true, trim: true, default: "" },
    phone:  { type: String, trim: true, default: "" },
    source: { type: String, default: "Manual" },
    status: { type: String, default: "new", trim: true },
    tags:   [{ type: String }],
    notes:  { type: String, default: "" },
    value:  { type: Number, default: 0 },

    // Lead assignment (GHL-style). `assignedTo` is the TeamMember who owns
    // this lead; `assignedTeam` is that member's team (denormalised so the
    // table can show the team badge and routing rules can filter by team).
    assignedTo:   { type: mongoose.Schema.Types.ObjectId, ref: "TeamMember", default: null, index: true },
    assignedTeam: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
    assignedAt:   { type: Date, default: null },
    // The team member who created this lead (null = created by the owner or an
    // automated source). Lets the owner see who added a lead.
    createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: "TeamMember", default: null },

    // Provenance for leads coming from Meta Lead Ads webhook — lets us dedupe
    // on retry and link back to the originating ad.
    metaLead: {
      leadgenId:    { type: String, index: true, sparse: true },
      formId:       String,
      adId:         String,
      adName:       String,
      campaignId:   String,
      campaignName: String,
      isOrganic:    Boolean,
      company:      String,
      rawFieldData: { type: mongoose.Schema.Types.Mixed },
      createdTime:  Date,
    },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.ownerId = ret.owner?.toString();
        delete ret._id;
        delete ret.owner;

        // Expose assignment as flat ids + friendly objects. Only build the
        // friendly {name,...} objects when the ref is actually POPULATED — a
        // populated ref is a plain subdoc, a non-populated one is a raw
        // ObjectId. (Note: a bson ObjectId's `_id` getter returns itself, so
        // never sniff `_id` to detect population — use `instanceof` instead.)
        const isId = (v) => v instanceof mongoose.Types.ObjectId;
        const at = ret.assignedTo;
        if (at && typeof at === "object" && !isId(at)) {
          const id = (at._id || at.id)?.toString() || null;
          ret.assignee = { id, name: at.name || "" };
          ret.assignedTo = id;
        } else {
          ret.assignedTo = at ? at.toString() : null;
        }
        const tm = ret.assignedTeam;
        if (tm && typeof tm === "object" && !isId(tm)) {
          const id = (tm._id || tm.id)?.toString() || null;
          ret.assigneeTeam = { id, name: tm.name || "", color: tm.color || "#7c3aed" };
          ret.assignedTeam = id;
        } else {
          ret.assignedTeam = tm ? tm.toString() : null;
        }
        return ret;
      },
    },
  }
);

leadSchema.index({ owner: 1, status: 1 });
leadSchema.index({ owner: 1, createdAt: -1 });

// Real-time notification on a brand-new lead. We flag "was new" in pre-save and
// emit in post-save so every creation path (manual add, autopilot create
// contact, form submit, etc. that uses .save()/.create()) pushes a live event.
leadSchema.pre("save", function (next) {
  this.$locals.wasNew = this.isNew;
  next();
});
leadSchema.post("save", function (doc) {
  if (!doc.$locals?.wasNew) return;
  try {
    const { emitToUser } = require("../services/socket");
    const who = doc.name || doc.email || doc.phone || "New contact";
    emitToUser(doc.owner, "notification:new", {
      type: "lead",
      title: `New lead from ${doc.source || "Manual"}`,
      sub: `${who} · just now`,
      ts: doc.createdAt || new Date(),
      link: `/leads/all/${doc._id.toString()}`,
    });
  } catch { /* socket not ready — non-fatal */ }
});

module.exports = mongoose.models.Lead || mongoose.model("Lead", leadSchema);
