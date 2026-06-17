const mongoose = require("mongoose");
const { DEFAULT_PIPELINE_STAGES } = require("../config/pipelineDefaults");

const pipelineStageSchema = new mongoose.Schema(
  {
    key:    { type: String, required: true },
    label:  { type: String, required: true },
    color:  { type: String, default: "#7c3aed" },
    system: { type: Boolean, default: false },
  },
  { _id: false }
);

// Per-user + per-organization: pipeline columns, Meta/WhatsApp lead toggles.
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },

    pipelineStages: {
      type: [pipelineStageSchema],
      default: () => DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s })),
    },

    metaForms: {
      enabled:       { type: Boolean, default: true },
      defaultStatus: { type: String, default: "new" },
      defaultValue:  { type: Number, default: 0 },
      defaultTags:   [{ type: String }],
    },

    whatsapp: {
      enabled:         { type: Boolean, default: false },
      firstMessageOnly:{ type: Boolean, default: true },
      defaultStatus:   { type: String, default: "new" },
      defaultValue:    { type: Number, default: 0 },
      defaultTags:     [{ type: String, default: "whatsapp" }],
    },
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

schema.index({ user: 1, organization: 1 }, { unique: true });

function scopeQuery(userId, organizationId) {
  if (organizationId) {
    return { user: userId, organization: organizationId };
  }
  return {
    user: userId,
    $or: [{ organization: null }, { organization: { $exists: false } }],
  };
}

schema.statics.forScope = async function (userId, organizationId = null) {
  const orgId = organizationId || null;
  let doc = await this.findOne(scopeQuery(userId, orgId));

  if (!doc && orgId) {
    const legacy = await this.findOne(scopeQuery(userId, null));
    const orgDocs = await this.countDocuments({ user: userId, organization: { $ne: null } });
    if (legacy && orgDocs === 0) {
      legacy.organization = orgId;
      await legacy.save();
      doc = legacy;
    }
  }

  if (!doc) {
    try {
      doc = await this.create({
        user: userId,
        organization: orgId,
        pipelineStages: DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s })),
      });
    } catch (err) {
      // A legacy unique-on-user index (or a concurrent create) can reject this.
      // Fall back to the user's existing settings doc so the page still loads.
      if (err && err.code === 11000) {
        doc = await this.findOne(scopeQuery(userId, orgId)) || await this.findOne({ user: userId });
      }
      if (!doc) throw err;
    }
  }
  if (!doc.pipelineStages?.length) {
    doc.pipelineStages = DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s }));
    await doc.save();
  }
  return doc;
};

/** @deprecated Use forScope(userId, organizationId) */
schema.statics.forUser = async function (userId) {
  return this.forScope(userId, null);
};

module.exports = mongoose.models.LeadSettings || mongoose.model("LeadSettings", schema);
