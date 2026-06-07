const Campaign = require("../models/Campaign");
const Lead = require("../models/Lead");
const { getMailer, defaultFrom } = require("../services/mailer");

exports.list = async (req, res) => {
  const items = await Campaign.find({ owner: req.user._id }).sort({ createdAt: -1 });
  res.json({ items });
};

exports.create = async (req, res) => {
  const c = await Campaign.create({ ...req.body, owner: req.user._id });
  res.status(201).json(c);
};

exports.update = async (req, res) => {
  const c = await Campaign.findOneAndUpdate(
    { _id: req.params.id, owner: req.user._id },
    req.body,
    { new: true }
  );
  if (!c) return res.status(404).json({ error: "Not found" });
  res.json(c);
};

exports.remove = async (req, res) => {
  const r = await Campaign.deleteOne({ _id: req.params.id, owner: req.user._id });
  res.json({ deleted: r.deletedCount });
};

// Send campaign now — real SMTP if configured, mock otherwise
exports.send = async (req, res) => {
  const campaign = await Campaign.findOne({ _id: req.params.id, owner: req.user._id });
  if (!campaign) return res.status(404).json({ error: "Not found" });

  const leads = await Lead.find({ owner: req.user._id, email: { $ne: "" } });
  const t = getMailer();

  let sent = 0;
  for (const lead of leads) {
    const body = (campaign.body || "").replace(/\{\{firstName\}\}/g, lead.name.split(" ")[0]);
    try {
      if (t) {
        await t.sendMail({
          from:    defaultFrom(),
          to:      lead.email,
          subject: campaign.subject || campaign.name,
          html:    body,
        });
      }
      sent++;
    } catch (e) {
      console.warn("send failed:", lead.email, e.message);
    }
  }

  campaign.status = "active";
  campaign.stats.sent += sent;
  await campaign.save();
  res.json({ sent, mocked: !t });
};
