import { z } from 'zod';

const BankPayout = z.object({
  type: z.literal('BANK'),
  accountHolderName: z.string().trim().min(2, 'Name is too short').max(80),
  accountNumber: z.string().trim().regex(/^\d{9,18}$/, 'Account number must be 9-18 digits'),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code'),
  bankName: z.string().trim().max(80).optional(),
});

const UpiPayout = z.object({
  type: z.literal('UPI'),
  accountHolderName: z.string().trim().min(2, 'Name is too short').max(80),
  upiId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/, 'Enter a valid UPI ID like name@bank'),
});

export const UpsertBankAccountSchema = z.discriminatedUnion('type', [BankPayout, UpiPayout]);
export type UpsertBankAccountDto = z.infer<typeof UpsertBankAccountSchema>;
