export const AUCTION_CATEGORIES = [
  'Outerwear',
  'Tops',
  'Bottoms',
  'Footwear',
  'Accessories',
  'Bags',
  'Suits',
  'Knitwear',
  'Denim',
  'Vintage',
] as const;

export const PAGE_SIZE_DEFAULT = 24;
export const PAGE_SIZE_MAX = 60;

export const QUEUE_NAMES = {
  auctionLifecycle: 'auction-lifecycle',
  settlement: 'settlement',
} as const;

export const JOB_NAMES = {
  goLive: 'auction.go-live',
  endAuction: 'auction.end',
  paymentTimeout: 'settlement.payment-timeout',
  inspectionAutoRelease: 'settlement.inspection-auto-release',
  shippingDeadlineRefund: 'settlement.shipping-deadline-refund',
} as const;
