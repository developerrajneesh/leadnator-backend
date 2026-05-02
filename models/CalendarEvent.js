const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type:     { type: String, enum: ["meeting", "demo", "call", "followup", "task"], default: "meeting" },
    title:    { type: String, required: true, trim: true },
    start:    { type: Date, required: true, index: true },
    end:      { type: Date, required: true },
    attendees:[{ type: String }],
    location: { type: String, default: "" },
    notes:    { type: String, default: "" },
    leadId:   { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
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

schema.index({ user: 1, start: 1 });

module.exports = mongoose.models.CalendarEvent || mongoose.model("CalendarEvent", schema);
