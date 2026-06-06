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

module.exports = mongoose.models.Lead || mongoose.model("Lead", leadSchema);
