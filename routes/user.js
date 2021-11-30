const express = require("express");
const userRouter = express.Router();
const multer = require("multer");

const {
  retrieveUser,
  retrievePosts,
  bookmarkPost,
  followUser,
  retrieveFollowing,
  retrieveFollowers,
  searchUsers,
  confirmUser,
  changeAvatar,
  removeAvatar,
  updateProfile,
  retrieveSuggestedUsers,
  isUsernameAvaialble,
  becomeGuardian,
  petanduserdetails,
  getUserDetails,
  updateBioAndAvatar,
  showPeopleToFollow,
  getPendingGuardianRequests
} = require("../controllers/userController");
const { requireAuth, optionalAuth } = require("../controllers/authController");

userRouter.get("/getPendingGuardianRequests",requireAuth,getPendingGuardianRequests)
userRouter.get("/userDetails", requireAuth, getUserDetails);
userRouter.post('/showPeopleToFollow',requireAuth, showPeopleToFollow);
userRouter.get("/suggested/:max?", requireAuth, retrieveSuggestedUsers);
userRouter.get("/:username", optionalAuth, retrieveUser);
userRouter.post("/:username/posts", retrievePosts);
userRouter.post("/:userId/following", requireAuth, retrieveFollowing);
userRouter.post("/:userId/followers", requireAuth, retrieveFollowers);
userRouter.post("/:username/search", searchUsers);

userRouter.put("/confirm", requireAuth, confirmUser);
userRouter.put(
  "/avatar",
  multer({
    dest: "temp/",
    limits: { fieldSize: 8 * 1024 * 1024, fileSize: 1000000 },
  }).single("image"),
  requireAuth,
  changeAvatar
);
userRouter.put("/", requireAuth, updateProfile);
userRouter.put("/bioAndAvatar", requireAuth, updateBioAndAvatar);

userRouter.delete("/avatar", requireAuth, removeAvatar);

userRouter.post("/:postId/bookmark", requireAuth, bookmarkPost);
userRouter.post("/:userId/follow", requireAuth, followUser);
userRouter.get(
  "/isusernameavailable/:username",
  requireAuth,
  isUsernameAvaialble
);
userRouter.post("/addPet", requireAuth, becomeGuardian);
userRouter.patch("/petanduserdetails", requireAuth, petanduserdetails);

module.exports = userRouter;
