/**
 * Wire format for Socket.IO events. Both backend and frontend reference these
 * names — keep them in sync.
 */
export const SOCKET_EVENTS = {
  bidPlaced: 'bid:placed',
  auctionStatusChanged: 'auction:status-changed',
  auctionExtended: 'auction:extended',
  notificationNew: 'notification:new',
} as const;

export interface BidPlacedEvent {
  auctionId: string;
  bidId: string;
  amount: string;
  bidderId: string;
  placedAt: string;
}

export interface AuctionStatusChangedEvent {
  auctionId: string;
  status: string;
}

export interface AuctionExtendedEvent {
  auctionId: string;
  newEndsAt: string;
}

export interface NotificationNewEvent {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export const auctionRoom = (auctionId: string) => `auction:${auctionId}`;
export const userRoom = (userId: string) => `user:${userId}`;
