const router = require("express").Router();
const { protect } = require("../middleware/auth");
const { requireFeature } = require("../middleware/plan");
const { generate } = require("../controllers/aiController");

router.post("/generate", protect, requireFeature("ai"), generate);

module.exports = router;
