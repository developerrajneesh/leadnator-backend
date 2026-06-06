const router = require("express").Router();
const { protect } = require("../middleware/auth");
const c = require("../controllers/subscriptionController");

router.get ("/plans",      c.listPlans);
router.get ("/quote",      c.quote);
router.post("/subscribe",  protect, c.subscribe);
router.post("/:id/cancel", protect, c.cancel);

module.exports = router;
