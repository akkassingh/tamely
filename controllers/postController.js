const cloudinary = require("cloudinary").v2;
const linkify = require("linkifyjs");
const axios = require("axios");
require("linkifyjs/plugins/hashtag")(linkify);
const Animal = require("../models/Animal");
const Comment = require("../models/Comment");
const CommentReply = require("../models/CommentReply");
const CommentVote = require("../models/CommentVote");
const CommentReplyVote = require("../models/CommentReplyVote");
const Post = require("../models/Post");
const PostVote = require("../models/PostVote");
const Following = require("../models/Following");
const Followers = require("../models/Followers");
const Notification = require("../models/Notification");
const socketHandler = require("../handlers/socketHandler");
const fs = require("fs");
const ObjectId = require("mongoose").Types.ObjectId;

const {
  retrieveComments,
  formatCloudinaryUrl,
  populatePostsPipeline,
} = require("../utils/controllerUtils");
const filters = require("../utils/filters");

module.exports.createPost = async (req, res, next) => {
  const user = res.locals.user;
  const { caption, filter: filterName, postOwnerId, postOwnerType } = req.body;
  let post = undefined;
  const filterObject = filters.find((filter) => filter.name === filterName);
  const hashtags = [];
  linkify.find(caption).forEach((result) => {
    if (result.type === "hashtag") {
      hashtags.push(result.value.substring(1));
    }
  });

  if (!req.file) {
    return res
      .status(400)
      .send({ error: "Please provide the image to upload." });
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  try {
    const response = await cloudinary.uploader.upload(req.file.path);
    const moderationResponse = await axios.get(
      `https://api.moderatecontent.com/moderate/?key=${process.env.MODERATECONTENT_API_KEY}&url=${response.secure_url}`
    );

    if (moderationResponse.data.error) {
      return res
        .status(500)
        .send({ error: "Error moderating image, please try again later." });
    }

    if (moderationResponse.data.rating_index > 2) {
      return res.status(403).send({
        error: "The content was deemed too explicit to upload.",
      });
    }

    const thumbnailUrl = formatCloudinaryUrl(
      response.secure_url,
      {
        width: 400,
        height: 400,
      },
      true
    );
    fs.unlinkSync(req.file.path);
    post = new Post({
      image: response.secure_url,
      thumbnail: thumbnailUrl,
      filter: filterObject ? filterObject.filter : "",
      caption,
      author: user._id,
      hashtags,
      postOwnerDetails: {
        postOwnerId: postOwnerId,
        postOwnerType: postOwnerType,
      },
    });
    const postVote = new PostVote({
      post: post._id,
    });
    await post.save();
    await postVote.save();
    res.status(201).json({
      post,
      postVotes: [],
      comments: [],
      author: { avatar: user.avatar, username: user.username },
    });
  } catch (err) {
    next(err);
  }

  try {
    // Updating followers feed with post
    const followersDocument = await Followers.find({ user: user._id });
    const followers = followersDocument[0].followers;
    const postObject = {
      ...post.toObject(),
      author: { username: user.username, avatar: user.avatar },
      commentData: { commentCount: 0, comments: [] },
      postVotes: [],
    };

    // socketHandler.sendPost(req, postObject, user._id);
    followers.forEach((follower) => {
      socketHandler.sendPost(
        req,
        // Since the post is new there is no need to look up any fields
        postObject,
        follower.user
      );
    });
  } catch (err) {
    console.log(err);
  }
};

module.exports.deletePost = async (req, res, next) => {
  const { postId } = req.body;
  const user = res.locals.user;

  try {
    const post = await Post.findOne({ _id: postId, author: user._id });
    if (!post) {
      return res.status(404).send({
        error: "Could not find a post with that id associated with the user.",
      });
    }
    // This uses pre hooks to delete everything associated with this post i.e comments
    const postDelete = await Post.deleteOne({
      _id: postId,
    });
    if (!postDelete.deletedCount) {
      return res.status(500).send({ error: "Could not delete the post." });
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

module.exports.retrievePost = async (req, res, next) => {
  const { postId } = req.params;
  try {
    // Retrieve the post and the post's votes
    const post = await Post.aggregate([
      { $match: { _id: ObjectId(postId) } },
      {
        $lookup: {
          from: "postvotes",
          localField: "_id",
          foreignField: "post",
          as: "postVotes",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "author",
          foreignField: "_id",
          as: "author",
        },
      },
      { $unwind: "$author" },
      { $unwind: "$postVotes" },
      {
        $unset: [
          "author.password",
          "author.email",
          "author.private",
          "author.bio",
          "author.githubId",
        ],
      },
      {
        $addFields: { postVotes: "$postVotes.votes" },
      },
    ]);
    if (post.length === 0) {
      return res
        .status(404)
        .send({ error: "Could not find a post with that id." });
    }
    // Retrieve the comments associated with the post aswell as the comment's replies and votes
    const comments = await retrieveComments(postId, 0);

    return res.send({ ...post[0], commentData: comments });
  } catch (err) {
    next(err);
  }
};

module.exports.votePost = async (req, res, next) => {
  console.log("------------", req.body);
  const { postId, voterDetails, vote } = req.body;
  const user = res.locals.user;

  try {
    if (vote === true) {
      let check;
      if (voterDetails.voterType === "Animal") {
        check = await PostVote.find({
          $and: [
            { "voterDetails.voterId": ObjectId(voterDetails.voterId) },
            { post: ObjectId(postId) },
          ],
        });
        if (check.length > 0) {
          return res.send({ success: true });
        } else {
          let postVote = new PostVote({
            post: ObjectId(postId),
            voterDetails: {
              voterType: voterDetails.voterType,
              voterId: ObjectId(voterDetails.voterId),
            },
          });
          await postVote.save();
          return res.send({ success: true });

          // Sending a like notification
          // const post = await Post.findById(postId);
          // if (String(post.author) !== String(user._id)) {
          //   // Create thumbnail link
          //   const image = formatCloudinaryUrl(
          //     post.image,
          //     {
          //       height: 50,
          //       width: 50,
          //     },
          //     true
          //   );
          //   const notification = new Notification({
          //     sender: user._id,
          //     receiver: post.author,
          //     notificationType: "like",
          //     date: Date.now(),
          //     notificationData: {
          //       postId,
          //       image,
          //       filter: post.filter,
          //     },
          //   });

          //   await notification.save();
          //   socketHandler.sendNotification(req, {
          //     ...notification.toObject(),
          //     sender: {
          //       _id: user._id,
          //       username: user.username,
          //       avatar: user.avatar,
          //     },
          //   });
          //   return res.send({ success: true });
          // } else {
          //   return res.send({ success: true });
          // }
        }
      } else {
        check = await PostVote.find({
          $and: [
            { "voterDetails.voterId": user._id },
            { post: ObjectId(postId) },
          ],
        });
        if (check.length > 0) {
          return res.send({ success: true });
        } else {
          let postVote = new PostVote({
            post: ObjectId(postId),
            voterDetails: {
              voterType: voterDetails.voterType,
              voterId: user._id,
            },
          });
          await postVote.save();
          return res.send({ success: true });
        }
      }
    } else {
      let check;
      if (voterDetails.voterType === "Animal") {
        check = await PostVote.find({
          $and: [
            { "voterDetails.voterId": ObjectId(voterDetails.voterId) },
            { post: ObjectId(postId) },
          ],
        });
        if (check.length > 0) {
          let deletePostVote = await PostVote.findByIdAndDelete({
            _id: check[0]._id,
          });
          return res.send({ success: true });
        } else {
          return res.send({ success: true });
        }
      } else {
        check = await PostVote.find({
          $and: [
            { "voterDetails.voterId": user._id },
            { post: ObjectId(postId) },
          ],
        });
        if (check.length > 0) {
          let deletePostVote = await PostVote.findByIdAndDelete({
            _id: check[0]._id,
          });
          return res.send({ success: true });
        } else {
          return res.send({ success: true });
        }
      }
    }
  } catch (err) {
    next(err);
  }
};

module.exports.postComment = async (req, res, next) => {
  const { message, postId, authorDetails } = req.body;
  const user = res.locals.user;

  try {
    let postComment = new Comment({
      post: ObjectId(postId),
      message: message,
      authorDetails: {
        authorType: authorDetails.authorType,
        authorId: ObjectId(authorDetails.authorId),
      },
    });
    await postComment.save();
    return res.send({ success: true });
  } catch (err) {
    next(err);
  }
};

module.exports.editComment = async (req, res, next) => {
  const { message, commentId } = req.body;
  const user = res.locals.user;

  try {
    let editComment = await Comment.findByIdAndUpdate(
      { _id: ObjectId(commentId) },
      { message: message }
    );
    return res.send({ success: true });
  } catch (err) {
    next(err);
  }
};

module.exports.deleteComment = async (req, res, next) => {
  console.log("----------inside deleteComment---------");
  const { commentId } = req.body;
  const user = res.locals.user;

  try {
    let deleteComment = await Comment.findByIdAndDelete({
      _id: ObjectId(commentId),
    });
    return res.send({ success: true });
  } catch (err) {
    console.log("---------", err);
    next(err);
  }
};

module.exports.postSubComment = async (req, res, next) => {
  const { message, parentCommentId, authorDetails } = req.body;
  const user = res.locals.user;

  try {
    let postCommentReply = new CommentReply({
      parentComment: ObjectId(parentCommentId),
      message: message,
      authorDetails: {
        authorType: authorDetails.authorType,
        authorId: ObjectId(authorDetails.authorId),
      },
    });
    await postCommentReply.save();
    return res.send({ success: true });
  } catch (err) {
    next(err);
  }
};

module.exports.editSubComment = async (req, res, next) => {
  const { message, subCommentId } = req.body;
  const user = res.locals.user;

  try {
    let editSubComment = await CommentReply.findByIdAndUpdate(
      { _id: ObjectId(subCommentId) },
      { message: message }
    );
    return res.send({ success: true });
  } catch (err) {
    next(err);
  }
};

module.exports.deleteSubComment = async (req, res, next) => {
  console.log("----------inside deleteComment---------");
  const { subCommentId } = req.body;
  const user = res.locals.user;

  try {
    let deleteSubComment = await CommentReply.findByIdAndDelete({
      _id: ObjectId(subCommentId),
    });
    return res.send({ success: true });
  } catch (err) {
    console.log("---------", err);
    next(err);
  }
};

module.exports.postCommentVote = async (req, res, next) => {
  const { commentId, voterDetails, flag } = req.body;
  const user = res.locals.user;

  try {
    if (flag === true) {
      let voterId =
        voterDetails.voterId === null ? user._id : voterDetails.voterId;
      let getCommentVote = await CommentVote.find({
        $and: [{ commentId: commentId }, { "voterDetails.voterId": voterId }],
      });
      if (getCommentVote.length > 0) {
        return res.send({ success: true });
      } else {
        let storeCommentVote = new CommentVote({
          commentId: ObjectId(commentId),
          voterDetails: {
            voterType: voterDetails.voterType,
            voterId: voterDetails.voterId === null ? user._id : voterId,
          },
        });
        await storeCommentVote.save();
        return res.send({ success: true });
      }
    } else {
      let voterId =
        voterDetails.voterId === null ? user._id : voterDetails.voterId;
      let getCommentVote = await CommentVote.find({
        $and: [{ commentId: commentId }, { "voterDetails.voterId": voterId }],
      });
      if (getCommentVote.length > 0) {
        await CommentVote.findByIdAndDelete({ _id: getCommentVote[0]._id });
      }
      return res.send({ success: true });
    }
  } catch (err) {
    next(err);
  }
};

module.exports.postSubCommentVote = async (req, res, next) => {
  const { subCommentId, voterDetails, flag } = req.body;
  const user = res.locals.user;

  try {
    if (flag === true) {
      let voterId =
        voterDetails.voterId === null ? user._id : voterDetails.voterId;
      let getCommentVote = await CommentReplyVote.find({
        $and: [
          { comment: ObjectId(subCommentId) },
          { "voterDetails.voterId": voterId },
        ],
      });
      if (getCommentVote.length > 0) {
        return res.send({ success: true });
      } else {
        let storeCommentVote = new CommentReplyVote({
          comment: ObjectId(subCommentId),
          voterDetails: {
            voterType: voterDetails.voterType,
            voterId: voterDetails.voterId === null ? user._id : voterId,
          },
        });
        await storeCommentVote.save();
        return res.send({ success: true });
      }
    } else {
      let voterId =
        voterDetails.voterId === null ? user._id : voterDetails.voterId;
      let getCommentVote = await CommentReplyVote.find({
        $and: [
          { comment: ObjectId(subCommentId) },
          { "voterDetails.voterId": voterId },
        ],
      });
      if (getCommentVote.length > 0) {
        await CommentReplyVote.findByIdAndDelete({
          _id: getCommentVote[0]._id,
        });
      }
      return res.send({ success: true });
    }
  } catch (err) {
    next(err);
  }
};

// module.exports.votePost = async (req, res, next) => {
//   const { postId } = req.params;
//   const user = res.locals.user;

//   try {
//     // Update the vote array if the user has not already liked the post
//     const postLikeUpdate = await PostVote.updateOne(
//       { post: ObjectId(postId), voterId: { $ne: user._id } },
//       {
//         $push: { voterId: user._id },
//       }
//     );
//     if (!postLikeUpdate.nModified) {
//       if (!postLikeUpdate.ok) {
//         return res.status(500).send({ error: "Could not vote on the post." });
//       }
//       // Nothing was modified in the previous query meaning that the user has already liked the post
//       // Remove the user's like
//       const postDislikeUpdate = await PostVote.updateOne(
//         { post: ObjectId(postId) },
//         { $pull: { voterId: user._id } }
//       );

//       if (!postDislikeUpdate.nModified) {
//         return res.status(500).send({ error: "Could not vote on the post." });
//       }
//     } else {
//       // Sending a like notification
//       const post = await Post.findById(postId);
//       if (String(post.author) !== String(user._id)) {
//         // Create thumbnail link
//         const image = formatCloudinaryUrl(
//           post.image,
//           {
//             height: 50,
//             width: 50,
//           },
//           true
//         );
//         const notification = new Notification({
//           sender: user._id,
//           receiver: post.author,
//           notificationType: "like",
//           date: Date.now(),
//           notificationData: {
//             postId,
//             image,
//             filter: post.filter,
//           },
//         });

//         await notification.save();
//         socketHandler.sendNotification(req, {
//           ...notification.toObject(),
//           sender: {
//             _id: user._id,
//             username: user.username,
//             avatar: user.avatar,
//           },
//         });
//       }
//     }
//     return res.send({ success: true });
//   } catch (err) {
//     next(err);
//   }
// };

module.exports.retrievePostFeed = async (req, res, next) => {
  const user = res.locals.user;
  const { offset } = req.params;

  try {
    const followingDocument = await Following.findOne({ user: user._id });
    if (!followingDocument) {
      return res.status(404).send({ error: "Could not find any posts." });
    }
    const following = followingDocument.following.map(
      (following) => following.user
    );

    // Fields to not include on the user object
    const unwantedUserFields = [
      "author.password",
      "author.private",
      "author.confirmed",
      "author.bookmarks",
      "author.email",
      "author.website",
      "author.bio",
      "author.githubId",
    ];

    const posts = await Post.aggregate([
      {
        $match: {
          $or: [{ author: { $in: following } }, { author: ObjectId(user._id) }],
        },
      },
      { $sort: { date: -1 } },
      { $skip: Number(offset) },
      { $limit: 5 },
      {
        $lookup: {
          from: "users",
          localField: "author",
          foreignField: "_id",
          as: "author",
        },
      },
      {
        $lookup: {
          from: "postvotes",
          localField: "_id",
          foreignField: "post",
          as: "postVotes",
        },
      },
      {
        $lookup: {
          from: "comments",
          let: { postId: "$_id" },
          pipeline: [
            {
              // Finding comments related to the postId
              $match: {
                $expr: {
                  $eq: ["$post", "$$postId"],
                },
              },
            },
            { $sort: { date: -1 } },
            { $limit: 3 },
            // Populating the author field
            {
              $lookup: {
                from: "users",
                localField: "author",
                foreignField: "_id",
                as: "author",
              },
            },
            {
              $lookup: {
                from: "commentvotes",
                localField: "_id",
                foreignField: "comment",
                as: "commentVotes",
              },
            },
            {
              $unwind: "$author",
            },
            {
              $unwind: {
                path: "$commentVotes",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $unset: unwantedUserFields,
            },
            {
              $addFields: {
                commentVotes: "$commentVotes.votes",
              },
            },
          ],
          as: "comments",
        },
      },
      {
        $lookup: {
          from: "comments",
          let: { postId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ["$post", "$$postId"],
                },
              },
            },
            {
              $group: { _id: null, count: { $sum: 1 } },
            },
            {
              $project: {
                _id: false,
              },
            },
          ],
          as: "commentCount",
        },
      },
      {
        $unwind: {
          path: "$commentCount",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $unwind: "$postVotes",
      },
      {
        $unwind: "$author",
      },
      {
        $addFields: {
          postVotes: "$postVotes.votes",
          commentData: {
            comments: "$comments",
            commentCount: "$commentCount.count",
          },
        },
      },
      {
        $unset: [...unwantedUserFields, "comments", "commentCount"],
      },
    ]);
    return res.send(posts);
  } catch (err) {
    next(err);
  }
};

module.exports.retrieveSuggestedPosts = async (req, res, next) => {
  const { offset = 0 } = req.params;

  try {
    const posts = await Post.aggregate([
      {
        $sort: { date: -1 },
      },
      {
        $skip: Number(offset),
      },
      {
        $limit: 20,
      },
      {
        $sample: { size: 20 },
      },
      ...populatePostsPipeline,
    ]);
    return res.send(posts);
  } catch (err) {
    next(err);
  }
};

module.exports.retrievMyPosts = async (req, res, next) => {
  const { offset = 0 } = req.params;

  try {
    // const authorId = ObjectId(res.locals.user._id);
    const authorId = res.locals.user._id.toString();
    const posts = await Post.aggregate([
      { $match: { author: authorId } },
      {
        $sort: { date: -1 },
      },
      {
        $skip: Number(offset),
      },
      {
        $limit: 20,
      },
    ]);

    for (let p1 of posts) {
      let getPostVoteresp = await PostVote.aggregate([
        {
          $match: { post: p1._id },
        },
        {
          $count: "totalVotes",
        },
      ]);
      p1.totalVotes = getPostVoteresp[0].totalVotes;
      p1.totalComments = 0;
    }

    // const posts = await Post.aggregate([
    //   { $match: { author: authorId } },
    //   {
    //     $sort: { date: -1 },
    //   },
    //   {
    //     $skip: Number(offset),
    //   },
    //   {
    //     $limit: 20,
    //   },
    //   {
    //     $sample: { size: 20 },
    //   },
    //   ...populatePostsPipeline,
    // ]);
    return res.send(posts);
  } catch (err) {
    console.log(err);
    next(err);
  }
};

module.exports.retrieveHashtagPosts = async (req, res, next) => {
  const { hashtag, offset } = req.params;

  try {
    const posts = await Post.aggregate([
      {
        $facet: {
          posts: [
            {
              $match: { hashtags: hashtag },
            },
            {
              $skip: Number(offset),
            },
            {
              $limit: 20,
            },
            ...populatePostsPipeline,
          ],
          postCount: [
            {
              $match: { hashtags: hashtag },
            },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
      {
        $unwind: "$postCount",
      },
      {
        $addFields: {
          postCount: "$postCount.count",
        },
      },
    ]);

    return res.send(posts[0]);
  } catch (err) {
    next(err);
  }
};
