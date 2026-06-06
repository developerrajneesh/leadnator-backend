/** Default Kanban columns — copied into LeadSettings on first load. */
const DEFAULT_PIPELINE_STAGES = [
  { key: "new",       label: "New",       color: "#3b82f6", system: true },
  { key: "contacted", label: "Contacted", color: "#f59e0b", system: true },
  { key: "qualified", label: "Qualified", color: "#10b981", system: true },
  { key: "hot",       label: "Hot",       color: "#ef4444", system: true },
  { key: "lost",      label: "Lost",      color: "#9ca3af", system: true },
];

const SYSTEM_STAGE_KEYS = new Set(DEFAULT_PIPELINE_STAGES.map((s) => s.key));

function slugKey(label, existing = []) {
  const base = String(label || "stage")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "") || "stage";
  const taken = new Set(existing.map((s) => s.key));
  let key = base;
  let n = 2;
  while (taken.has(key)) {
    key = `${base}_${n++}`;
  }
  return key;
}

function normalizeStages(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s }));
  }
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    const key = String(raw?.key || "").trim().toLowerCase();
    const label = String(raw?.label || "").trim();
    const color = String(raw?.color || "#7c3aed").trim();
    if (!key || !/^[a-z0-9_-]{1,48}$/.test(key)) continue;
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: label.slice(0, 40),
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#7c3aed",
      system: SYSTEM_STAGE_KEYS.has(key),
    });
  }
  return out.length ? out : DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s }));
}

module.exports = {
  DEFAULT_PIPELINE_STAGES,
  SYSTEM_STAGE_KEYS,
  slugKey,
  normalizeStages,
};
