// Platform audit log. A single global middleware records every MUTATING API
// call (POST/PUT/PATCH/DELETE under /api) plus auth events, so the admin sees
// exactly what every user did — sign up, login, create campaign/webhook/event,
// connect Instagram/email, etc. Reads (GET) are page views, not actions, so
// they're skipped to keep the trail meaningful.

const ActivityLog = require("../models/ActivityLog");

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Friendly module names keyed by the first path segment after /api/.
const MODULE_LABELS = {
  auth: "Auth", wa: "WhatsApp", meta: "Meta Ads", instagram: "Instagram",
  email: "Email", calendar: "Calendar", autopilot: "Autopilot", leads: "Leads",
  "lead-flows": "Lead flow", "lead-settings": "Lead settings", storage: "Storage",
  support: "Support", profile: "Profile", pricing: "Billing", orgs: "Workspace",
  campaigns: "Campaign", ai: "AI", admin: "Admin", public: "Public", dashboard: "Dashboard",
};

const VERB = { POST: "Created", PUT: "Updated", PATCH: "Updated", DELETE: "Deleted" };

// Build a human-readable action label + module key for a request.
function deriveAction(req) {
  const parts = (req.path || "").split("/").filter(Boolean); // ["api","wa","templates"]
  const module = parts[1] || "";
  const resource = parts[2] || "";
  const label = MODULE_LABELS[module] || module || "API";

  // Auth + a few well-known specials read better with custom phrasing.
  const specials = {
    "POST /api/auth/login": "Logged in",
    "POST /api/auth/signup": "Signed up",
    "POST /api/auth/forgot-password": "Requested password reset",
    "POST /api/auth/reset-password": "Reset password",
    "POST /api/wa/embedded-connect": "Connected WhatsApp",
    "POST /api/wa/disconnect": "Disconnected WhatsApp",
    "POST /api/meta/connect": "Connected Meta",
    "POST /api/meta/disconnect": "Disconnected Meta",
    "POST /api/public/booking": "Booked a slot",
  };
  const keyExact = `${req.method} ${req.path}`;
  if (specials[keyExact]) return { module: module || "auth", action: specials[keyExact] };
  // booking with id param: POST /api/public/booking/:id
  if (req.method === "POST" && /^\/api\/public\/booking\//.test(req.path)) {
    return { module: "calendar", action: "Booked a slot (public)" };
  }

  const verb = VERB[req.method] || req.method;
  const tail = resource && !/^[0-9a-f]{24}$/i.test(resource) ? ` ${resource.replace(/-/g, " ")}` : "";
  return { module, action: `${verb} ${label}${tail}`.trim() };
}

function record(req, res) {
  try {
    const u = req.user;
    const m = req.member;
    const authEmail = req.path.startsWith("/api/auth/") ? (req.body?.email || "") : "";
    ActivityLog.create({
      user: u?._id || null,
      userEmail: String(m?.email || u?.email || authEmail || "").toLowerCase(),
      userName: String(m?.name || u?.name || ""),
      role: u?.role || (m ? "member" : "anonymous"),
      organization: req.tenantId || null,
      ...deriveAction(req),
      method: req.method,
      path: (req.originalUrl || req.path || "").split("?")[0],
      statusCode: res.statusCode,
      ip: req.ip || "",
      userAgent: String(req.headers["user-agent"] || "").slice(0, 240),
      ts: new Date(),
    }).catch(() => {}); // never let logging break a request
  } catch { /* swallow */ }
}

function middleware() {
  return (req, res, next) => {
    const p = req.path || "";
    // Only audit mutating /api calls; skip the log viewer itself.
    if (!p.startsWith("/api") || !MUTATING.has(req.method) || p.startsWith("/api/admin/logs")) {
      return next();
    }
    res.on("finish", () => record(req, res));
    next();
  };
}

module.exports = { middleware, deriveAction };
