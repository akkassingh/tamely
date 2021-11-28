const express = require("express");
const animalRouter = express.Router();
const multer = require("multer");

const upload = multer({
  dest: "temp/",
  limits: { fieldSize: 8 * 1024 * 1024, fileSize: 1000000 },
}).any();

const {
  registerPet,
  addGuardian,
  getPetDetails,
  editPet,
  editPetHabits,
  getGuardians
} = require("../controllers/animalController");

const { requireAuth, requireAuthAnimal } = require("../controllers/authController");

animalRouter.post("/register", upload, requireAuth, registerPet);
animalRouter.post("/addGuardian", requireAuthAnimal, addGuardian);
animalRouter.post("/getPetDetails", requireAuth, getPetDetails);
animalRouter.put("/editPet", upload, requireAuth, editPet);
animalRouter.post("/editPetHabits", requireAuth, editPetHabits);
animalRouter.get('/getGuardians', requireAuth, getGuardians);
module.exports = animalRouter;
