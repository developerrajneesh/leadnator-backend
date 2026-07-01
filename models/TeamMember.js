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

    // Lead visibility scope (GHL-style). "all" = sees every lead in the
    // workspace; "assigned" = sees only leads assigned to them.
    leadAccess: { type: String, enum: ["all", "assigned"], default: "all" },

    // Per-member table preferences — each member picks their own Leads-table
    // columns / pipeline card fields independently of the owner.
    leadColumns:    { type: [String], default: [] },
    leadCardFields: { type: [String], default: [] },

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
// Mongoose 8: async pre-save hooks must not call next() — it is undefined.
schema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  if (this.password.startsWith("$2a$") || this.password.startsWith("$2b$")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// Static: create a member with a plaintext password that will be hashed.
// Use this instead of `new TeamMember({...}).save()` when you need to be
// sure the password gets hashed (since findOneAndUpdate bypasses hooks).
schema.statics.createWithPassword = async function (doc) {
  const member = new this(doc);
  return member.save();
};

schema.methods.comparePassword = function (plain) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(plain, this.password);
};

// Returns a user-shaped payload the frontend can treat just like a User —
// the frontend uses `role` to pick admin vs user routes, so we always
// return `role: "user"` for team members and expose their team-role under
// `memberRole`. `ownerId` lets the UI know they're acting under a tenant.
schema.methods.toSafeJSON = function () {
  return {
    id:           this._id.toString(),
    name:         this.name,
    email:        this.email,
    phone:        this.phone || "",
    role:         "user",
    status:       this.status,
    isTeamMember: true,
    memberRole:   this.role,
    leadAccess:   this.leadAccess || "all",
    permissions:  this.permissions || {},
    team:         this.team ? this.team.toString() : null,
    ownerId:      this.owner ? this.owner.toString() : null,
    createdAt:    this.createdAt,
    updatedAt:    this.updatedAt,
  };
};

module.exports = mongoose.models.TeamMember || mongoose.model("TeamMember", schema);
