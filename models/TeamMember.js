const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");

// Per-module / per-sub-route boolean permission map. Each module key
// lists sub-routes the member is allowed to access. Missing sub-route
// = denied. Missing module = denied. Example:
//   {
//     dashboard: { overview: true, activity: true },
//     leads:     { all: true, pipeline: true, settings: false },
//   }
const permissionSchema = new mongoose.Schema({}, { _id: false, strict: false });

const schema = new mongoose.Schema(
  {
    owner:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    team:   { type: mongoose.Schema.Types.ObjectId, ref: "Team", index: true },
    name:   { type: String, required: true, trim: true },
    email:  { type: String, required: true, trim: true, lowercase: true },
    phone:  { type: String, default: "", trim: true },
    password: { type: String, default: "", select: false },

    role:   { type: String, enum: ["Owner", "Admin", "Member", "Viewer"], default: "Member" },
    status: { type: String, enum: ["active", "pending", "suspended"], default: "pending" },

    // Per-module permissions — see schema docblock above.
    permissions: { type: permissionSchema, default: {} },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        if (ret.team) ret.team = ret.team.toString();
        delete ret._id;
        delete ret.owner;
        delete ret.password;
        return ret;
      },
    },
  }
);

schema.index({ owner: 1, email: 1 }, { unique: true });

// Hash password if it was just set (and isn't already a bcrypt hash).
schema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  if (this.password.startsWith("$2a$") || this.password.startsWith("$2b$")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// Static: create a member with a plaintext password that will be hashed.
// Use this instead of `new TeamMember({...}).save()` when you need to be
// sure the password gets hashed (since findOneAndUpdate bypasses hooks).
schema.statics.createWithPassword = async function (doc) {
  const member = new this(doc);
  return member.save();
};

module.exports = mongoose.models.TeamMember || mongoose.model("TeamMember", schema);
