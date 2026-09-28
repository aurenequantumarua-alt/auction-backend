/**
 * Wire format for Socket.IO events. Both backend and frontend reference these
 * names — keep them in sync.
 */
export const SOCKET_EVENTS = {
  bidPlaced: 'bid:placed',
  auctionStatusChanged: 'auction:status-changed',
  auctionExtended: 'auction:extended',
  notificationNew: 'notification:new',
  inquiryNew: 'inquiry:new',
  inquiryAnswered: 'inquiry:answered',
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

export interface InquiryEvent {
  id: string;
  auctionId: string;
  question: string;
  answer?: string | null;
  answeredAt?: string | null;
  imageUrl?: string | null;
  isPinned: boolean;
  createdAt: string;
  asker: { id: string; name: string; avatarUrl: string | null };
}

export const auctionRoom = (auctionId: string) => `auction:${auctionId}`;
export const userRoom = (userId: string) => `user:${userId}`;

