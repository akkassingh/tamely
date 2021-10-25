const jwt = require('jwt-simple');
const crypto = require('crypto');
const User = require('../models/User');
const ConfirmationToken = require('../models/ConfirmationToken');
const bcrypt = require('bcrypt');
const axios = require('axios');
const logger = require('../logger/logger');

const {
  sendConfirmationEmail,
  generateUniqueUsername,
  sendEmail,
  sendPasswordResetLink
} = require('../utils/controllerUtils');
const {
  validateEmail,
  validatePassword,
} = require('../utils/validation');

module.exports.verifyJwt = (token) => {
  return new Promise(async (resolve, reject) => {
    try {
      const id = jwt.decode(token, process.env.JWT_SECRET).id;
      const user = await User.findOne(
        { _id: id },
        'email username avatar bookmarks bio fullName confirmed website'
      );
      if (user) {
        return resolve(user);
      } else {
        reject('Not authorized.');
      }
    } catch (err) {
      return reject('Not authorized.');
    }
  });
};

module.exports.requireAuth = async (req, res, next) => {
  const { authorization } = req.headers;
  if (!authorization) return res.status(401).send({ error: 'Not authorized.' });
  try {
    const user = await this.verifyJwt(authorization);
    // Allow other middlewares to access the authenticated user details.
    res.locals.user = user;
    return next();
  } catch (err) {
    return res.status(401).send({ error: err });
  }
};

module.exports.optionalAuth = async (req, res, next) => {
  const { authorization } = req.headers;
  if (authorization) {
    try {
      const user = await this.verifyJwt(authorization);
      // Allow other middlewares to access the authenticated user details.
      res.locals.user = user;
    } catch (err) {
      return res.status(401).send({ error: err });
    }
  }
  return next();
};

module.exports.loginAuthentication = async (req, res, next) => {
  const { authorization } = req.headers;
  const { usernameOrEmail, password } = req.body;
  if (authorization) {
    try {
      const user = await this.verifyJwt(authorization);
      return res.send({
        user,
        token: authorization,
      });
    } catch (err) {
      return res.status(401).send({ error: err });
    }
  }

  if (!usernameOrEmail || !password) {
    return res
      .status(400)
      .send({ error: 'Please provide both a username/email and a password.' });
  }

  try {
    const user = await User.findOne({
      $or: [{ username: usernameOrEmail }, { email: usernameOrEmail }],
    });
    if (!user || !user.password) {
      return res.status(401).send({
        error: 'The credentials you provided are incorrect, please try again.',
      });
    }

    bcrypt.compare(password, user.password, (err, result) => {
      if (err) {
        return next(err);
      }
      if (!result) {
        return res.status(401).send({
          error:
            'The credentials you provided are incorrect, please try again.',
        });
      }

      res.send({
        user: {
          _id: user._id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
        },
        token: jwt.encode({ id: user._id }, process.env.JWT_SECRET),
      });
    });
  } catch (err) {
    next(err);
  }
};

module.exports.register = async (req, res, next) => {
  logger.info("*** Register method called ***");
  const { email, password } = req.body;
  let user = null;
  let confirmationToken = null;

  const emailError = validateEmail(email);
  if (emailError) return res.status(400).send({ error: emailError });

  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).send({ error: passwordError });

  try {
    let username = email.split('@')[0];
    username = await generateUniqueUsername(username);
    logger.info('Unique username is', username);
    user = new User({ email, password, username });
    confirmationToken = new ConfirmationToken({
      user: user._id,
      token: crypto.randomBytes(20).toString('hex'),
    });
    await user.save();
    await confirmationToken.save();
    res.status(201).send({
      user: {
        email: user.email,
        username: user.username,
        isNewUser: true
      },
      token: jwt.encode({ id: user._id }, process.env.JWT_SECRET),
    });
    sendConfirmationEmail(user.username, user.email, confirmationToken.token);
  } catch (err) {
    logger.info("error while register new user: ", err);
    next(err);
  }
  // sendConfirmationEmail(user.username, user.email, confirmationToken.token);
};

module.exports.githubLoginAuthentication = async (req, res, next) => {
  const { code, state } = req.body;
  if (!code || !state) {
    return res
      .status(400)
      .send({ error: 'Please provide a github access code and state.' });
  }

  try {
    // Exchange the temporary code with an access token
    const response = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        state,
      }
    );
    const accessToken = response.data.split('&')[0].split('=')[1];

    // Retrieve the user's info
    const githubUser = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `token ${accessToken}` },
    });

    // Retrieve the user's email addresses
    // Private emails are not provided in the previous request
    const emails = await axios.get('https://api.github.com/user/emails', {
      headers: { Authorization: `token ${accessToken}` },
    });
    const primaryEmail = emails.data.find((email) => email.primary).email;

    const userDocument = await User.findOne({ githubId: githubUser.data.id });
    if (userDocument) {
      return res.send({
        user: {
          _id: userDocument._id,
          email: userDocument.email,
          username: userDocument.username,
          avatar: userDocument.avatar,
          bookmarks: userDocument.bookmarks,
          isNewUser: false,
        },
        token: jwt.encode({ id: userDocument._id }, process.env.JWT_SECRET),
      });
    }

    const existingUser = await User.findOne({
      $or: [{ email: primaryEmail }, { username: githubUser.data.login }],
    });

    if (existingUser) {
      if (existingUser.email === primaryEmail) {
        return res.status(400).send({
          error:
            'A user with the same email already exists, please change your primary github email.',
        });
      }
      if (existingUser.username === githubUser.data.login.toLowerCase()) {
        const username = await generateUniqueUsername(githubUser.data.login);
        githubUser.data.login = username;
      }
    }

    const user = new User({
      email: primaryEmail,
      fullName: githubUser.data.name,
      username: githubUser.data.login,
      githubId: githubUser.data.id,
      avatar: githubUser.data.avatar_url,
    });

    await user.save();
    return res.send({
      user: {
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        bookmarks: user.bookmarks,
        isNewUSer: true,
      },
      token: jwt.encode({ id: user._id }, process.env.JWT_SECRET),
    });
  } catch (err) {
    next(err);
  }
};

module.exports.facebookRedirect = async (req, res, next) => {
  return res.status(200).send('success');
};

module.exports.googleRedirect = async (req, res, next) => {
  return res.status(200).send('success');
};

module.exports.facebookLoginAuthentication = async (req, res, next) => {
  const { code, state } = req.body;
  if (!code || !state) {
    return res
      .status(400)
      .send({error: 'Please provide valid credentials'});
  }
  try{
    const { data } = await axios({
      url: 'https://graph.facebook.com/v4.0/oauth/access_token',
      method: 'get',
      params: {
        client_id: process.env.FACEBOOK_CLIENT_ID,
        client_secret: process.env.FACEBOOK_CLIENT_SECRET,
        redirect_uri: `${process.env.HOME_URL}/api/auth/authenticate/facebook/`,
        grant_type: 'authorization_code',
        code,
        state
      },
    });
    const accessToken = data.access_token;
    console.log(accessToken)
    logger.info("accessToken is ",JSON.stringify(accessToken));
    logger.info("*******************************************");

    // Retrieve the user's info
    //{ locale: 'en_US', fields: 'name, email' }
    const fbUser = await axios.get('https://graph.facebook.com/v2.5/me?fields=id,name,email,first_name,last_name', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log('fbUser is as below');
    console.log(fbUser.data);
    logger.info("fbUser is ", JSON.stringify(fbUser.data))
    const primaryEmail = fbUser.data.email;
    const facebookId = fbUser.data.id;
    const userDocument = await User.findOne({ facebookId });
    logger.info('userDocument is ', JSON.stringify(userDocument));
    if (userDocument) {
      return res.send({
        user: {
          _id: userDocument._id,
          email: userDocument.email,
          username: userDocument.username,
          avatar: userDocument.avatar,
          bookmarks: userDocument.bookmarks,
          isNewUser: false,
        },
        token: jwt.encode({ id: userDocument._id }, process.env.JWT_SECRET),
      });
    }

    const existingUser = await User.findOne({
      $or: [{ email: primaryEmail }, { username: fbUser.data.first_name+fbUser.data.last_name.toLowerCase() }],
    });

    logger.info("existingUser is ", JSON.stringify(existingUser));

    if (existingUser) {
      logger.info("User Exists!!!!");
      if (existingUser.email === primaryEmail) {
        return res.status(400).send({
          error:
            'A user with the same email already exists, please change your email.',
        });
      }
      if (existingUser.username === fbUser.data.first_name+fbUser.data.last_name.toLowerCase()) {
        const username = await generateUniqueUsername(fbUser.data.first_name+fbUser.data.last_name.toLowerCase());
        fbUser.data.login = username;
      }
    }
    logger.info("fbUser is ", JSON.stringify(fbUser.data));
    const user = new User({
      email: primaryEmail,
      fullName: fbUser.data.name,
      username: fbUser.data.login ? fbUser.data.login : fbUser.data.first_name+fbUser.data.last_name.toLowerCase(),
      facebookId: fbUser.data.id,
    });

    await user.save();
    return res.send({
      user: {
        email: user.email,
        username: user.username,
        bookmarks: user.bookmarks,
        isNewUser: true,
      },
      token: jwt.encode({ id: user._id }, process.env.JWT_SECRET),
    });
  } catch (err) {
    console.log(err)
    logger.err("err is ", err);
    next(err);
  }
};

module.exports.googleLoginAuthentication = async (req, res, next) => {
  const { code } = req.body;
  if (!code ) {
    return res
      .status(400)
      .send({ error: 'Please provide valid code and state.' });
  }
  try{
    const { data } = await axios({
      url: 'https://oauth2.googleapis.com/token',
      method: 'post',
      params: {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `http://localhost:9000/api/auth/authenticate/google`,
        grant_type: 'authorization_code',
        code
      },
    });
    const accessToken = data.access_token;

    console.log("accessToken is ", accessToken);
    
    // Retrieve the user's info
    const googleUserResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    logger.info("googleUser is ", JSON.stringify(googleUserResponse.data))
    googleUser = googleUserResponse.data;
    const primaryEmail = googleUser.email;
    const googleUserId = googleUser.id;
    const userDocument = await User.findOne({ googleUserId });
    logger.info('userDocument is ', JSON.stringify(userDocument));
    if (userDocument) {
      return res.send({
        user: {
          _id: userDocument._id,
          email: userDocument.email,
          username: userDocument.username,
          avatar: userDocument.avatar,
          bookmarks: userDocument.bookmarks,
          isNewUser: false,
        },
        token: jwt.encode({ id: userDocument._id }, process.env.JWT_SECRET),
      });
    }

    const existingUser = await User.findOne({
      $or: [{ email: primaryEmail }, { username: googleUser.given_name+googleUser.family_name.toLowerCase() }],
    });

    logger.info("existingUser is ", JSON.stringify(existingUser));

    if (existingUser) {
      logger.info("User Exists!!!!");
      if (existingUser.email === primaryEmail) {
        return res.status(400).send({
          error:
            'A user with the same email already exists, please change your email.',
        });
      }
      if (existingUser.username === googleUser.given_name+googleUser.family_name.toLowerCase()) {
        const username = await generateUniqueUsername(googleUser.given_name+googleUser.family_name.toLowerCase());
        fbUser.data.login = username;
      }
    }
    logger.info("googleUser is ", JSON.stringify(googleUser.data));
    const user = new User({
      email: primaryEmail,
      fullName: googleUser.name,
      username: googleUser.login ? googleUser.login : googleUser.given_name+googleUser.family_name.toLowerCase(),
      googleUserId: googleUserId,
    });

    await user.save();
    return res.send({
      user: {
        email: user.email,
        username: user.username,
        bookmarks: user.bookmarks,
        isNewUser: true,
      },
      token: jwt.encode({ id: user._id }, process.env.JWT_SECRET),
    });
  }catch (err) {
    console.log(err)
    return res
    .status(400)
    .send({ err });
  }
};

module.exports.changePassword = async (req, res, next) => {
  const { oldPassword, newPassword } = req.body;
  const user = res.locals.user;
  let currentPassword = undefined;

  try {
    const userDocument = await User.findById(user._id);
    currentPassword = userDocument.password;

    const result = await bcrypt.compare(oldPassword, currentPassword);
    if (!result) {
      return res.status('401').send({
        error: 'Your old password was entered incorrectly, please try again.',
      });
    }

    const newPasswordError = validatePassword(newPassword);
    if (newPasswordError)
      return res.status(400).send({ error: newPasswordError });

    userDocument.password = newPassword;
    await userDocument.save();
    return res.send();
  } catch (err) {
    return next(err);
  }
};

module.exports.resetPassword = async (req, res, next) => {
  try{
    logger.info("***Reset Password called***")
    const {email} = req.body;
    if (email){
      const user = await User.findOne({email});
      if (!user) return res.status(404).send("No user with given username exist");

      // const token = await ConfirmationToken.findOne({user: user._id});
      const current_time = Date.now();
      await sendPasswordResetLink(email,current_time);
      res.status(201).json({'message':`Password Reset Link Sent to Email ID of user ${user._id}`, 'result':'success'})
    }
  }
  catch (err){
    logger.info(err)
    res.status(500).send({err});
    console.log(error);
  }
}

module.exports.updatePassword = async(req,res,next) => {
  logger.info("***Update Password called***")
  const {id,time} = req.params;
  const {newPassword} = req.body;
  let user = null;
  try{
    user = await User.findById(id);
    if (!user || (user.passwordRestTime + 900000) < Date.now()) res.status(404).send('The link you are trying to access is either invalid or expired. The link was valid for 15 minutes only.');
    const newPasswordError = validatePassword(newPassword);
    if (newPasswordError)
      return res.status(400).send({ error: newPasswordError });
      
      await User.findOneAndUpdate({_id: id}, {password: bcrypt.hashSync(newPassword, 10)});
      sendEmail(user.email,'Password Changed', 'Your password was changed successfully!')
      res.status(201).json({'message':'Your password was reset successfully!','result':'success'})
  }
  catch (err){
    logger.info(err)
    res.status(500).send({err});
    console.log(err)
  }
}