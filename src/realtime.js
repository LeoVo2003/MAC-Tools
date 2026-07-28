/**
 * Socket.IO rooms theo user — mỗi user join `user:<id>`, F5 reconnect vẫn vào room đó.
 * Log/queue/result chỉ emit trong room → không lẫn / không hủy nhầm của người khác trên UI.
 */
import { Server } from 'socket.io';
import { findUserById } from './userStore.js';

/** @type {import('socket.io').Server | null} */
let io = null;

export function getIo() {
  return io;
}

/**
 * @param {import('http').Server} httpServer
 * @param {{ sessionMiddleware: Function, queue: object }} deps
 */
export function attachRealtime(httpServer, { sessionMiddleware, queue }) {
  io = new Server(httpServer, {
    path: '/socket.io',
    // Same-origin; cookie session
    cors: { origin: false },
    serveClient: true,
    // Job dài (backup / Mac Role) — tránh proxy cắt khi im lặng
    pingInterval: 20000,
    pingTimeout: 60000,
  });

  // Share express-session với handshake Socket.IO
  io.engine.use((req, res, next) => {
    sessionMiddleware(req, res, next);
  });

  io.use((socket, next) => {
    try {
      const userId = socket.request?.session?.userId;
      if (!userId) return next(new Error('unauthorized'));
      const user = findUserById(userId);
      if (!user) return next(new Error('unauthorized'));
      socket.data.userId = String(user.id);
      socket.data.username = user.username;
      socket.data.role = user.role;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', (socket) => {
    const room = userRoom(socket.data.userId);
    socket.join(room);
    socket.data.jobId = null;
    console.log(`[socket] ${socket.data.username} → ${room}`);

    const snap = queue.snapshotForUser(socket.data.userId, {
      admin: socket.data.role === 'admin',
    });
    socket.emit('hello', { ok: true, room, queue: snap });

    socket.on('watch-job', (jobIdRaw) => {
      const jobId = jobIdRaw ? String(jobIdRaw) : null;
      socket.data.jobId = jobId;
      if (!jobId) return;

      const job = queue.getJob(jobId);
      if (!job) return;
      // Chỉ replay job của chính user (admin cũng chỉ xem job mình watch nếu thuộc họ)
      if (String(job.meta?.userId || '') !== socket.data.userId) return;

      for (const line of (job.logs || []).slice(-80)) {
        socket.emit('log', { line, jobId });
      }
      if (job.result) {
        socket.emit('result', { ...job.result, jobId });
      }
      if (job.error && (job.status === 'error' || job.status === 'cancelled')) {
        socket.emit('job-error', {
          message: job.error,
          jobId,
          cancelled: job.status === 'cancelled',
        });
      }
    });

    socket.on('disconnect', () => {
      /* room leave tự động */
    });
  });

  console.log('[socket] rooms sẵn sàng — path /socket.io');
  return { io, broadcast: createBroadcaster(queue) };
}

export function userRoom(userId) {
  return `user:${String(userId)}`;
}

function createBroadcaster(queue) {
  /**
   * @param {string} event
   * @param {object|null} data
   * @param {{ jobId?: string, userId?: string, refreshQueues?: boolean }} [opts]
   */
  return function broadcast(event, data, opts = {}) {
    if (!io) return;

    // Queue: gửi snapshot đã lọc cho từng socket (mỗi user chỉ thấy job của mình)
    if (event === 'queue' || opts.refreshQueues) {
      for (const socket of io.of('/').sockets.values()) {
        const uid = socket.data?.userId;
        if (!uid) continue;
        const snap = queue.snapshotForUser(uid, { admin: socket.data.role === 'admin' });
        socket.emit('queue', snap);
      }
      return;
    }

    let uid = opts.userId ? String(opts.userId) : null;
    if (!uid && opts.jobId) {
      uid = queue.getJob(opts.jobId)?.meta?.userId
        ? String(queue.getJob(opts.jobId).meta.userId)
        : null;
    }

    if (!uid) {
      console.warn(`[socket] broadcast "${event}" thiếu userId/jobId — bỏ qua`);
      return;
    }

    // Nếu client đang watch job khác, vẫn gửi log của job này (họ có thể có nhiều tab);
    // Client tự filter theo currentJobId nếu cần.
    io.to(userRoom(uid)).emit(event, data);
  };
}
