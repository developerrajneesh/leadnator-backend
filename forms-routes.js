// Form generator — authenticated CRUD. Public view/submit lives in public-routes.js.
const express = require("express");
const Form = require("./models/Form");
const { tenantId } = require("./middleware/tenant");

const router = express.Router();

// Publish / re-publish a form (upsert by formId, scoped to the user).
router.post("/", async (req, res, next) => {
  try {
    const { formId, title, description = "", submitLabel = "Submit", fields = [], style = {} } = req.body || {};
    if (!formId) return res.status(400).json({ error: "formId required" });
    if (!Array.isArray(fields) || fields.length === 0) {
      return res.status(400).json({ error: "Add at least one field before publishing." });
    }

    const form = await Form.findOneAndUpdate(
      { formId, user: req.user._id },
      {
        $set: { title, description, submitLabel, fields, style },
        $setOnInsert: { organization: tenantId(req) || null },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ form: form.toJSON() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "That form id is already taken." });
    next(err);
  }
});

// List the user's published forms (with submission counts).
router.get("/", async (req, res, next) => {
  try {
    const forms = await Form.find({ user: req.user._id }).sort({ updatedAt: -1 });
    res.json({
      forms: forms.map((f) => ({
        id: f.id, formId: f.formId, title: f.title,
        fields: f.fields?.length || 0,
        submissions: f.submissions?.length || 0,
        updatedAt: f.updatedAt,
      })),
    });
  } catch (err) { next(err); }
});

// Full form definition for the builder (edit mode).
router.get("/:formId", async (req, res, next) => {
  try {
    const form = await Form.findOne({ formId: req.params.formId, user: req.user._id });
    if (!form) return res.status(404).json({ error: "Form not found" });
    res.json({ form: form.toJSON() });
  } catch (err) { next(err); }
});

// View submissions for one form.
router.get("/:formId/submissions", async (req, res, next) => {
  try {
    const form = await Form.findOne({ formId: req.params.formId, user: req.user._id });
    if (!form) return res.status(404).json({ error: "Form not found" });
    res.json({
      title: form.title,
      fields: form.fields,
      submissions: (form.submissions || []).slice().reverse(),
    });
  } catch (err) { next(err); }
});

router.delete("/:formId", async (req, res, next) => {
  try {
    const r = await Form.deleteOne({ formId: req.params.formId, user: req.user._id });
    if (!r.deletedCount) return res.status(404).json({ error: "Form not found" });
    res.json({ deleted: req.params.formId });
  } catch (err) { next(err); }
});

module.exports = router;
