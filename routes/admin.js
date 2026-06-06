const router = require("express").Router();
const { protect, authorize } = require("../middleware/auth");
const c = require("../controllers/adminController");

router.use(protect, authorize("admin"));

router.get ("/users",              c.listUsers);
router.put ("/users/:id/plan",     c.changePlan);
router.put ("/users/:id/status",   c.setStatus);
router.get ("/stats",              c.stats);

module.exports = router;
