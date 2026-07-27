import { z } from 'zod';

export const PlaceBidSchema = z.object({
  amount: z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'number' ? v.toString() : v))
    .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), 'Invalid amount')
    .refine((v) => Number(v) >= 0.01, 'Amount must be positive'),
});
export type PlaceBidDto = z.infer<typeof PlaceBidSchema>;
