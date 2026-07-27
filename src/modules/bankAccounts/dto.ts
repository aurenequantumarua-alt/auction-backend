import { z } from 'zod';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^(\+?91)?[6-9]\d{9}$/, 'Enter a valid Indian mobile number');

/** Canonical 10-digit form (strip +91, spaces, etc.). */
export const normalizePhone = (p: string): string => p.replace(/\D/g, '').slice(-10);

export const RequestOtpSchema = z.object({ phone: phoneSchema });
export type RequestOtpDto = z.infer<typeof RequestOtpSchema>;

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
  idToken: z.string().min(1, 'Missing Firebase token'),
  upiId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/, 'Enter a valid UPI ID like name@bank')
    .optional(),
});

export const UpsertBankAccountSchema = z.discriminatedUnion('type', [BankPayout, UpiPayout]);
export type UpsertBankAccountDto = z.infer<typeof UpsertBankAccountSchema>;
