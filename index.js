require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const mongoose = require('mongoose');
const compression = require('compression');
const path = require('path');
const socketio = require('socket.io');
const jwt = require('jwt-simple');
const logger = require('./logger/logger');
const morgan = require('morgan');

const apiRouter = require('./routes');

const app = express();
const PORT = process.env.PORT || 9000;

if (process.env.NODE_ENV !== 'production') {
  const morgan = require('morgan');
  app.use(morgan('dev'));
}

app.use(helmet());
app.use(helmet.hidePoweredBy());
app.use(cors());
app.use(bodyParser.json());
app.use(morgan('tiny', { stream: logger.stream }));
app.set('trust proxy', 1);
app.use('/api', apiRouter);


if (process.env.NODE_ENV === 'production') {
  app.use(compression());
  // app.use(express.static(path.join(__dirname, 'client/build')));

  app.get('*', function (req, res) {
    res.send(path.join(__dirname, 'client/build', 'index.html'));
  });
}

(async function () {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      useCreateIndex: true,
    });
    logger.info('Connected to database');
  } catch (err) {
    logger.error('Connection to database failed ', err);
    throw new Error(err);
  }
})();

app.use((err, req, res, next) => {
  logger.info(err.message);
  if (!err.statusCode) {
    err.statusCode = 500;
  }
  if (err.name === 'MulterError') {
    if (err.message === 'File too large') {
      return res
        .status(400)
        .send({ error: 'Your file exceeds the limit of 10MB.' });
    }
  }
  res.status(err.statusCode || 500).send({
    error:
      err.statusCode >= 500
        ? 'An unexpected error ocurred, please try again later.'
        : err.message,
  });
});

const expressServer = app.listen(PORT, () => {
  logger.info(`Backend listening on port::::::: ${PORT}`);
});

const io = socketio(expressServer);
app.set('socketio', io);
logger.info('Socket.io listening for connections');

// Authenticate before establishing a socket connection
io.use((socket, next) => {
  const token = socket.handshake.query.token;
  if (token) {
    try {
      const user = jwt.decode(token, process.env.JWT_SECRET);
      if (!user) {
        return next(new Error('Not authorized.'));
      }
      socket.user = user;
      return next();
    } catch (err) {
      next(err);
    }
  } else {
    return next(new Error('Not authorized.'));
  }
}).on('connection', (socket) => {
  socket.join(socket.user.id);
  logger.info('socket connected:', socket.id);
});
