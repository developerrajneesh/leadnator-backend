const mongoose = require('mongoose');

const autopilotSchema = new mongoose.Schema({
  name: { type: String, required: true },
  organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  key: { type: String, required: true, unique: true, index: true },
  config: { type: mongoose.Schema.Types.Mixed },
  status: { type: String, enum: ['active','disabled'], default: 'active' },
  // Inbound-call telemetry. `callCount` is the lifetime total; `calls` keeps
  // the most recent invocations (capped) so the builder's Logs panel can show
  // exactly what arrived — headers, query params, and body — per call.
  callCount: { type: Number, default: 0 },
  lastCalledAt: { type: Date },
  calls: [{
    _id: false,
    runId: String,
    ts: { type: Date, default: Date.now },
    ip: String,
    method: String,
    headers: { type: mongoose.Schema.Types.Mixed },
    query: { type: mongoose.Schema.Types.Mixed },
    body: { type: mongoose.Schema.Types.Mixed },
    // Per-node execution trace: [{ nodeId, type, title, status, branch, input, output, message }]
    steps: { type: [mongoose.Schema.Types.Mixed], default: [] },
  }],
}, {
  timestamps: true,
  toJSON: { versionKey: false, transform: (_doc, ret) => { ret.id = ret._id?.toString(); delete ret._id; return ret; } },
});

module.exports = mongoose.models.Autopilot || mongoose.model('Autopilot', autopilotSchema);
