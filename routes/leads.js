const router = require("express").Router();
const multer = require("multer");
const { protect } = require("../middleware/auth");
const { checkLeadLimit } = require("../middleware/plan");
const c = require("../controllers/leadController");

const upload = multer({ dest: "uploads/" });

router.use(protect);

router.get   ("/",              c.list);
router.post  ("/",              checkLeadLimit, c.create);
router.post  ("/import",        upload.single("file"), c.importCsv);
router.get   ("/:id",           c.getOne);
router.put   ("/:id",           c.update);
router.delete("/:id",           c.remove);
router.put   ("/:id/notes",     c.addNote);

module.exports = router;
