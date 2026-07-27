import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { auctionRoom, SOCKET_EVENTS, userRoom } from './events.js';
import type {
  AuctionExtendedEvent,
  AuctionStatusChangedEvent,
  BidPlacedEvent,
  NotificationNewEvent,
} from './events.js';
import type { AccessTokenPayload } from '../middleware/auth.js';

let io: SocketServer | null = null;

export const initRealtime = (httpServer: HttpServer): SocketServer => {
  io = new SocketServer(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS,
      credentials: true,
    },
    path: '/socket.io',
  });

  io.use((socket, next) => {
    // Auth is optional — anonymous viewers can subscribe to auction rooms.
    const token = (socket.handshake.auth?.token as string | undefined) ?? null;
    if (!token) return next();
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
      socket.data.user = payload;
      void socket.join(userRoom(payload.sub));
    } catch {
      // Bad token — proceed unauthenticated.
    }
    next();
  });

  io.on('connection', (socket: Socket) => {
    socket.on('auction:subscribe', (auctionId: string) => {
      if (typeof auctionId !== 'string' || auctionId.length > 64) return;
      void socket.join(auctionRoom(auctionId));
    });
    socket.on('auction:unsubscribe', (auctionId: string) => {
      if (typeof auctionId !== 'string') return;
      void socket.leave(auctionRoom(auctionId));
    });
  });

  logger.info('Socket.IO gateway ready');
  return io;
};

const emitToRoom = (room: string, event: string, payload: unknown): void => {
  if (!io) return;
  io.to(room).emit(event, payload);
};

export const realtime = {
  emitBidPlaced(auctionId: string, payload: Omit<BidPlacedEvent, 'auctionId'>): void {
    emitToRoom(auctionRoom(auctionId), SOCKET_EVENTS.bidPlaced, { auctionId, ...payload });
  },
  emitAuctionStatus(auctionId: string, status: string): void {
    const evt: AuctionStatusChangedEvent = { auctionId, status };
    emitToRoom(auctionRoom(auctionId), SOCKET_EVENTS.auctionStatusChanged, evt);
  },
  emitAuctionExtended(auctionId: string, newEndsAt: string): void {
    const evt: AuctionExtendedEvent = { auctionId, newEndsAt };
    emitToRoom(auctionRoom(auctionId), SOCKET_EVENTS.auctionExtended, evt);
  },
  emitNotification(userId: string, payload: NotificationNewEvent): void {
    emitToRoom(userRoom(userId), SOCKET_EVENTS.notificationNew, payload);
  },
};
