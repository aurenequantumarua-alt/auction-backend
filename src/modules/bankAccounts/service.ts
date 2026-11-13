import type { BankAccount } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { encrypt, last4 } from '../../lib/bankCrypto.js';
import type { UpsertBankAccountDto } from './dto.js';

export type MaskedPayoutMethod =
  | {
      type: 'BANK';
      accountHolderName: string;
      last4: string;
      ifsc: string;
      bankName: string | null;
      status: string;
    }
  | {
      type: 'UPI';
      accountHolderName: string;
      upiId: string;
      status: string;
    };

const mask = (acct: BankAccount): MaskedPayoutMethod => {
  if (acct.type === 'UPI') {
    return {
      type: 'UPI',
      accountHolderName: acct.accountHolderName,
      upiId: acct.upiId ?? '',
      status: acct.status,
    };
  }
  return {
    type: 'BANK',
    accountHolderName: acct.accountHolderName,
    last4: acct.accountNumberLast4 ?? '',
    ifsc: acct.ifsc ?? '',
    bankName: acct.bankName,
    status: acct.status,
  };
};

/** Human-readable destination label for a payout (used when snapshotting withdrawals). */
export const payoutDestinationLabel = (acct: BankAccount): string =>
  acct.type === 'UPI'
    ? acct.upiId ?? ''
    : `••••${acct.accountNumberLast4 ?? ''}`;

export interface IfscInfo {
  ifsc: string;
  bank: string;
  branch: string;
  city: string;
  state: string;
  upi: boolean;
}

/**
 * Resolve an IFSC to its real bank + branch using Razorpay's free public IFSC
 * directory (no auth, no RazorpayX). Returns null for a malformed or unknown IFSC.
 */
export const lookupIfsc = async (ifsc: string): Promise<IfscInfo | null> => {
  const code = ifsc.trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) return null;
  try {
    const res = await fetch(`https://ifsc.razorpay.com/${code}`);
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;
    if (!d || typeof d !== 'object' || !('BANK' in d)) return null;
    return {
      ifsc: String(d.IFSC ?? code),
      bank: String(d.BANK ?? ''),
      branch: String(d.BRANCH ?? ''),
      city: String(d.CITY ?? ''),
      state: String(d.STATE ?? ''),
      upi: Boolean(d.UPI),
    };
  } catch {
    return null;
  }
};

export const bankAccountService = {
  /** The caller's masked payout method, or null. Never exposes the full number. */
  async getMine(userId: string): Promise<MaskedPayoutMethod | null> {
    const acct = await prisma.bankAccount.findUnique({ where: { userId } });
    return acct ? mask(acct) : null;
  },

  /** True when the user has a VERIFIED payout method — the gating predicate. */
  async hasVerified(userId: string): Promise<boolean> {
    const acct = await prisma.bankAccount.findUnique({
      where: { userId },
      select: { status: true },
    });
    return acct?.status === 'VERIFIED';
  },

  /**
   * Create or replace the user's single payout method.
   *  - BANK: number AES-GCM encrypted at rest; only last4 returned.
   *  - UPI:  stores UPI ID directly; no phone verification required.
   */
  async upsert(userId: string, dto: UpsertBankAccountDto): Promise<MaskedPayoutMethod> {
    if (dto.type === 'UPI') {
      const data = {
        type: 'UPI' as const,
        accountHolderName: dto.accountHolderName,
        phone: null,
        phoneVerifiedAt: null,
        upiId: dto.upiId,
        // clear any prior BANK fields
        accountNumberEnc: null,
        accountNumberLast4: null,
        ifsc: null,
        bankName: null,
        status: 'VERIFIED' as const,
      };
      const acct = await prisma.bankAccount.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
      return mask(acct);
    }

    // BANK
    const data = {
      type: 'BANK' as const,
      accountHolderName: dto.accountHolderName,
      accountNumberEnc: encrypt(dto.accountNumber),
      accountNumberLast4: last4(dto.accountNumber),
      ifsc: dto.ifsc,
      bankName: dto.bankName ?? null,
      // clear any prior UPI fields
      upiId: null,
      phone: null,
      phoneVerifiedAt: null,
      status: 'VERIFIED' as const,
    };
    const acct = await prisma.bankAccount.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return mask(acct);
  },

  async remove(userId: string): Promise<void> {
    await prisma.bankAccount.deleteMany({ where: { userId } });
  },
};

