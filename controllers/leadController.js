const fs = require("fs");
const csv = require("csv-parser");
const Lead = require("../models/Lead");
const { PLANS } = require("../config/plans");

exports.list = async (req, res) => {
  const { q, status, source, page = 1, limit = 50 } = req.query;
  const filter = { owner: req.user._id };
  if (status) filter.status = status;
  if (source) filter.source = source;
  if (q) filter.$or = [
    { name:  new RegExp(q, "i") },
    { email: new RegExp(q, "i") },
    { phone: new RegExp(q, "i") },
  ];

  const [items, total] = await Promise.all([
    Lead.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit),
    Lead.countDocuments(filter),
  ]);
  res.json({ items, total, page: +page, limit: +limit });
};

exports.create = async (req, res) => {
  const lead = await Lead.create({ ...req.body, owner: req.user._id });
  res.status(201).json(lead);
};

exports.getOne = async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, owner: req.user._id });
  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
};

exports.update = async (req, res) => {
  const lead = await Lead.findOneAndUpdate(
    { _id: req.params.id, owner: req.user._id },
    req.body,
    { new: true }
  );
  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
};

exports.remove = async (req, res) => {
  const ok = await Lead.deleteOne({ _id: req.params.id, owner: req.user._id });
  res.json({ deleted: ok.deletedCount });
};

exports.addNote = async (req, res) => {
  const lead = await Lead.findOneAndUpdate(
    { _id: req.params.id, owner: req.user._id },
    { $set: { notes: req.body.notes || "" } },
    { new: true }
  );
  if (!lead) return res.status(404).json({ error: "Not found" });
  res.json(lead);
};

// CSV import — respects the plan's lead limit
exports.importCsv = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "CSV file required" });

  const plan = PLANS[req.user.plan.id];
  const current = await Lead.countDocuments({ owner: req.user._id });
  const remaining = isFinite(plan.leadLimit) ? plan.leadLimit - current : Infinity;

  const rows = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (r) => rows.push(r))
    .on("end", async () => {
      const toInsert = rows.slice(0, remaining).map((r) => ({
        owner:  req.user._id,
        name:   r.name   || r.Name   || "Unnamed",
        email:  r.email  || r.Email  || "",
        phone:  r.phone  || r.Phone  || "",
        source: r.source || "Import",
        status: "new",
      }));
      const inserted = await Lead.insertMany(toInsert, { ordered: false });
      fs.unlink(req.file.path, () => {});
      res.json({ imported: inserted.length, skipped: rows.length - inserted.length, remaining });
    })
    .on("error", (err) => res.status(500).json({ error: err.message }));
};
