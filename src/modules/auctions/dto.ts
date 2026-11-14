import { z } from 'zod';
import { AUCTION_CATEGORIES } from '../../config/constants.js';

const moneyString = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v))
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), 'Invalid money value')
  .refine((v) => Number(v) >= 0.01, 'Must be at least 0.01');

const optionalMoneyString = z
  .union([z.number(), z.string()])
  .optional()
  .nullable()
  .transform((v) => {
    if (v === null || v === undefined || v === '') return undefined;
    return typeof v === 'number' ? v.toString() : v;
  })
  .refine((v) => v === undefined || (/^\d+(\.\d{1,2})?$/.test(v) && Number(v) >= 0.01), 'Invalid money value');

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid ISO date');

const AuctionFieldsSchema = z.object({
  title: z.string().min(3).max(140).trim(),
  description: z.string().min(20).max(4000),
  category: z.enum(AUCTION_CATEGORIES),
  brand: z.string().min(1).max(80).trim(),
  condition: z.enum(['NEW', 'LIKE_NEW', 'GOOD', 'FAIR']),
  size: z.string().min(1).max(20).trim(),
  basePrice: moneyString,
  minIncrement: moneyString,
  buyNowPrice: optionalMoneyString,
  startsAt: isoDate,
  endsAt: isoDate,
  tags: z.array(z.string().min(1).max(24).regex(/^[\w\s\-&,.''·×]+$/, 'Tags may only contain letters, numbers, spaces, hyphens, and basic punctuation')).max(10).default([]),
  provenance: z.string().max(4000).optional().nullable(),
  provenanceProofUrls: z.array(z.string().url().refine((u) => u.startsWith('https://'), 'URL must use HTTPS')).max(10).default([]),
  images: z
    .array(
      z.object({
        url: z.string().url().refine((u) => u.startsWith('https://'), 'URL must use HTTPS'),
        isCover: z.boolean().default(false),
      }),
    )
    .min(1, 'At least one image is required')
    .max(10),
  publish: z.boolean().default(false),
});

export const CreateAuctionSchema = AuctionFieldsSchema
  .refine((d) => Date.parse(d.endsAt) > Date.parse(d.startsAt), {
    path: ['endsAt'],
    message: 'endsAt must be after startsAt',
  })
  .refine((d) => Date.parse(d.endsAt) > Date.now(), {
    path: ['endsAt'],
    message: 'endsAt must be in the future',
  })
  .refine(
    (d) => {
      // Must be scheduled at least 24 hours in advance (with 5-minute clock buffer)
      const start = Date.parse(d.startsAt);
      const minStart = Date.now() + 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
      return start >= minStart;
    },
    {
      path: ['startsAt'],
      message: 'Auctions cannot start immediately. Must be scheduled at least 24 hours (1 day) in advance.',
    },
  )
  .refine(
    (d) => {
      // Cannot be scheduled more than 30 days in advance
      const start = Date.parse(d.startsAt);
      const maxStart = Date.now() + 30 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000;
      return start <= maxStart;
    },
    {
      path: ['startsAt'],
      message: 'Auction cannot be scheduled more than 30 days (1 month) in advance.',
    },
  )
  .refine(
    (d) => {
      // Auction bidding window is strictly 24 hours (+/- 5 min form tolerance)
      const durationMs = Date.parse(d.endsAt) - Date.parse(d.startsAt);
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      return Math.abs(durationMs - twentyFourHoursMs) <= 5 * 60 * 1000;
    },
    {
      path: ['endsAt'],
      message: 'Auction window must be strictly 24 hours.',
    },
  )
  .refine(
    (d) => {
      if (!d.buyNowPrice) return true;
      return Number(d.buyNowPrice) > Number(d.basePrice) * 1.2;
    },
    {
      path: ['buyNowPrice'],
      message: 'Buy-now price must be at least 20% above the starting price',
    },
  );

export type CreateAuctionDto = z.infer<typeof CreateAuctionSchema>;

export const UpdateAuctionSchema = AuctionFieldsSchema.partial()
  .omit({ publish: true })
  .refine(
    (d) => {
      if (d.startsAt) {
        const start = Date.parse(d.startsAt);
        const minStart = Date.now() + 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
        const maxStart = Date.now() + 30 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000;
        return start >= minStart && start <= maxStart;
      }
      return true;
    },
    {
      path: ['startsAt'],
      message: 'Auction must be scheduled between 24 hours and 30 days in advance.',
    },
  )
  .refine(
    (d) => {
      if (d.startsAt && d.endsAt) {
        const duration = Date.parse(d.endsAt) - Date.parse(d.startsAt);
        return Math.abs(duration - 24 * 60 * 60 * 1000) <= 5 * 60 * 1000;
      }
      return true;
    },
    {
      path: ['endsAt'],
      message: 'Auction window must be strictly 24 hours.',
    },
  );
export type UpdateAuctionDto = z.infer<typeof UpdateAuctionSchema>;

export const AuctionListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(60).default(24),
  q: z.string().trim().min(1).max(80).optional(),
  category: z.enum(AUCTION_CATEGORIES).optional(),
  brand: z.string().trim().min(1).max(80).optional(),
  condition: z.enum(['NEW', 'LIKE_NEW', 'GOOD', 'FAIR']).optional(),
  status: z.enum(['UPCOMING', 'LIVE', 'ENDED', 'SOLD']).optional(),
  sort: z
    .enum(['newest', 'ending_soon', 'highest_bid', 'most_bids'])
    .default('newest'),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
});
export type AuctionListQuery = z.infer<typeof AuctionListQuerySchema>;
