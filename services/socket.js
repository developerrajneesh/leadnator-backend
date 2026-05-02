// Socket.IO server — powers real-time updates (inbox messages, status ticks).
//
// Design:
//   • Each authenticated user joins a private room named after their user._id.
//   • Other services emit to `wa.*` events in that room (e.g. wa.inbound when
//     the webhook saves a new inbound message).
//   • Auth handshake: the client sends the JWT as `auth: { token }`; we verify
//     with the same secret the HTTP API uses.
//
// Consumer pattern from anywhere in backend code:
//     const { emitToUser } = require("./services/socket");
//     emitToUser(userId, "wa.inbound", { ... });

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

let io = null;

function init(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || "http://localhost:5173",
      credentials: true,
    },
  });

  const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error("no token"));
      const payload = jwt.verify(token, JWT_SECRET);
      socket.userId = payload.id;
      socket.role   = payload.role;
      next();
    } catch (err) {
      next(new Error("invalid token"));
    }
  });

  io.on("connection", (socket) => {
    socket.join(`user:${socket.userId}`);
    if (socket.role) socket.join(`role:${socket.role}`);
    console.log(`[socket] user ${socket.userId} connected (${socket.id})`);
    socket.emit("ready", { userId: socket.userId });

    socket.on("disconnect", (reason) => {
      console.log(`[socket] user ${socket.userId} disconnected (${reason})`);
    });
  });

  console.log("[socket] Socket.IO ready");
  return io;
}

function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(`user:${String(userId)}`).emit(event, payload);
}

function emitToRole(role, event, payload) {
  if (!io) return;
  io.to(`role:${role}`).emit(event, payload);
}

function getIo() {
  return io;
}

module.exports = { init, emitToUser, emitToRole, getIo };
