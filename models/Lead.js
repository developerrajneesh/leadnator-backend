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
