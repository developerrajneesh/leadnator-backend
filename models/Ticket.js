const mongoose = require("mongoose");

// One message in the ticket thread. Authored either by the ticket owner
// (role="user") or by any admin responding (role="admin").
const messageSchema = new mongoose.Schema(
  {
    author:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    authorName: { type: String, default: "" },
    role:     { type: String, enum: ["user", "admin"], required: true },
    body:     { type: String, required: true },
    createdAt:{ type: Date,   default: Date.now },
  },
  { _id: true }
);

const ticketSchema = new mongoose.Schema(
  {
    code:     { type: String, required: true, unique: true },

    // Who opened the ticket. Kept as ObjectId for joins. `user` kept as
    // display-name for legacy admin list rendering.
    owner:    { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    user:     { type: String, required: true },      // display name
    userEmail:{ type: String, default: "" },

    subject:      { type: String, required: true },
    description:  { type: String, default: "" },
    priority: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    status:   { type: String, enum: ["open", "in_progress", "resolved"], default: "open" },
    category: { type: String, default: "General" },

    messages:      [messageSchema],
    lastMessageAt: { type: Date, default: null },
    unreadForUser: { type: Number, default: 0 }, // unread admin replies
    unreadForAdmin:{ type: Number, default: 0 }, // unread user replies
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        return ret;
      },
    },
  }
);

module.exports = mongoose.models.Ticket || mongoose.model("Ticket", ticketSchema);
