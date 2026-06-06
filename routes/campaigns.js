const router = require("express").Router();
const { protect } = require("../middleware/auth");
const { requireFeature } = require("../middleware/plan");
const c = require("../controllers/campaignController");

router.use(protect);

router.get   ("/",           c.list);
router.post  ("/",           c.create);
router.put   ("/:id",        c.update);
router.delete("/:id",        c.remove);

// Advanced / scheduled send — requires Growth or higher
router.post  ("/:id/send",   requireFeature("advancedEmail"), c.send);

module.exports = router;
