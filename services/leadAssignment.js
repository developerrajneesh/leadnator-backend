// Lead auto-assignment (GHL-style routing + round-robin).
//
// Flow for a brand-new lead:
//   1. Match the owner's enabled AssignmentRules (by source / tag) in priority
//      order — first match picks the target Team.
//   2. If no rule matches, fall back to the team flagged `autoAssign.isDefault`.
//   3. Round-robin the lead across that team's auto-assign pool (or all its
//      active members when no explicit pool is set).
//
// The round-robin cursor lives on the Team doc and is advanced atomically with
// $inc so concurrent lead creations don't hand the same member every time.

const Team = require("../models/Team");
const TeamMember = require("../models/TeamMember");
const AssignmentRule = require("../models/AssignmentRule");

function ci(s) { return String(s || "").trim().toLowerCase(); }

// Pick the next member for a team via round-robin. Returns the TeamMember doc
// (or null when the team has no eligible members). Advances rrCursor.
async function pickRoundRobin(team) {
  const pool = (team.autoAssign?.members || []).map(String);
  let members;
  if (pool.length) {
    members = await TeamMember.find({
      _id: { $in: pool }, owner: team.owner, status: "active",
    }).sort({ createdAt: 1 });
  } else {
    members = await TeamMember.find({
      owner: team.owner, team: team._id, status: "active",
    }).sort({ createdAt: 1 });
  }
  if (!members.length) return null;

  const idx = ((team.rrCursor || 0) % members.length + members.length) % members.length;
  const chosen = members[idx];
  // Advance the cursor for next time (atomic, don't clobber concurrent writes).
  await Team.updateOne({ _id: team._id }, { $inc: { rrCursor: 1 } });
  return chosen;
}

// Resolve which team a lead should route to, based on rules + default team.
// `owner` is an ObjectId/string; `organization` may be null.
async function resolveTeam({ owner, organization = null, source = "", tags = [] }) {
  const rules = await AssignmentRule.find({ owner, enabled: true })
    .sort({ priority: 1, createdAt: 1 });
  const src = ci(source);
  const tagSet = new Set((tags || []).map(ci));

  for (const r of rules) {
    // Respect org boundary when the rule is org-scoped.
    if (organization && r.organization && String(r.organization) !== String(organization)) continue;
    const srcOk = !r.matchSource || ci(r.matchSource) === src;
    const tagOk = !r.matchTag || tagSet.has(ci(r.matchTag));
    if (srcOk && tagOk) {
      const team = await Team.findOne({ _id: r.team, owner });
      if (team) return team;
    }
  }
  // Fall back to the default catch-all team.
  return Team.findOne({ owner, "autoAssign.enabled": true, "autoAssign.isDefault": true });
}

// Compute an assignment for a lead's attributes without touching a doc. Used by
// the bulk CSV import path (which builds plain objects for insertMany).
// Returns { assignedTo, assignedTeam, assignedAt } or null when unassigned.
async function resolveAssignment({ owner, organization = null, source = "", tags = [] }) {
  const team = await resolveTeam({ owner, organization, source, tags });
  if (!team || !team.autoAssign?.enabled) return null;
  const member = await pickRoundRobin(team);
  if (!member) return null;
  return { assignedTo: member._id, assignedTeam: team._id, assignedAt: new Date() };
}

// Auto-assign a freshly-created Lead document (mutates + saves it). Skips leads
// that already carry an assignment. Non-fatal: never throws to the caller.
async function autoAssignLead(lead) {
  try {
    if (!lead || lead.assignedTo) return lead;
    const a = await resolveAssignment({
      owner: lead.owner,
      organization: lead.organization || null,
      source: lead.source,
      tags: lead.tags,
    });
    if (!a) return lead;
    lead.assignedTo = a.assignedTo;
    lead.assignedTeam = a.assignedTeam;
    lead.assignedAt = a.assignedAt;
    await lead.save();
  } catch (err) {
    console.warn("[leadAssignment] auto-assign failed:", err.message);
  }
  return lead;
}

module.exports = { pickRoundRobin, resolveTeam, resolveAssignment, autoAssignLead };
