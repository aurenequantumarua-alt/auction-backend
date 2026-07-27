import { z } from 'zod';

// Keep the amount as an exact money STRING end-to-end (no JS float) so the
// Prisma.Decimal it becomes is precise. Max 2 decimal places.
export const RequestWithdrawalSchema = z.object({
  amount: z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'number' ? v.toString() : v.trim()))
    .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), 'Enter a valid amount (max 2 decimals)')
    .refine((v) => Number(v) > 0, 'Amount must be positive'),
});

export type RequestWithdrawalDto = z.infer<typeof RequestWithdrawalSchema>;
