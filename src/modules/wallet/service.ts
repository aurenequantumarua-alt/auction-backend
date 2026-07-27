import { Prisma, type WalletTxnType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../utils/http-error.js';
import { buildPage, skipTake, type PaginationQuery } from '../../utils/pagination.js';

/**
 * Tx client accepted by the ledger primitives. Either a transaction client
 * (preferred — lets the caller compose the wallet mutation with other writes
 * atomically, e.g. settlement) or the top-level prisma client (we then open our
 * own transaction).
 */
type TxClient = Prisma.TransactionClient;

interface LedgerArgs {
  userId: string;
  amountDecimal: Prisma.Decimal; // always POSITIVE; sign is derived from credit/debit
  type: WalletTxnType;
  reference?: string;
  idempotencyKey?: string;
  description?: string;
}

/**
 * Get-or-create the user's wallet. Safe under races: a unique-constraint
 * collision (two requests creating concurrently) is resolved by re-reading.
 */
const getOrCreate = async (userId: string, tx?: TxClient) => {
  const db = tx ?? prisma;
  const existing = await db.wallet.findUnique({ where: { userId } });
  if (existing) return existing;
  try {
    return await db.wallet.create({ data: { userId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const again = await db.wallet.findUnique({ where: { userId } });
      if (again) return again;
    }
    throw err;
  }
};

/**
 * Append a signed ledger row inside a row-locked transaction and update the
 * cached Wallet.balance. `signed` is the amount as it lands in the ledger
 * (positive for credits, negative for debits). The wallet row is locked FOR
 * UPDATE so concurrent mutations serialize and balanceAfter is always correct.
 *
 * Idempotency: when an idempotencyKey is supplied and a row with that key
 * already exists, we return the existing wallet WITHOUT changing the balance.
 */
const applyLedger = async (
  tx: TxClient,
  args: LedgerArgs,
  signed: Prisma.Decimal,
) => {
  const wallet = await getOrCreate(args.userId, tx);

  // Lock the wallet row for the rest of the transaction BEFORE checking
  // idempotency, so a concurrent same-key credit can't slip past the dup-check.
  await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${wallet.id} FOR UPDATE`;

  // Re-read inside the lock to get the authoritative current balance.
  const locked = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });

  if (args.idempotencyKey) {
    const dup = await tx.walletTransaction.findUnique({
      where: { idempotencyKey: args.idempotencyKey },
    });
    if (dup) return locked; // already applied — balance untouched
  }

  const balanceAfter = locked.balance.plus(signed);
  if (balanceAfter.isNegative()) {
    throw badRequest('Insufficient wallet balance');
  }

  try {
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: args.type,
        amount: signed,
        balanceAfter,
        reference: args.reference ?? null,
        idempotencyKey: args.idempotencyKey ?? null,
        description: args.description ?? null,
      },
    });
  } catch (err) {
    // Lost an idempotency race on the unique key -> already applied; do not
    // double-apply (leave the balance as the winning credit left it).
    if (
      args.idempotencyKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    }
    throw err;
  }

  return tx.wallet.update({
    where: { id: wallet.id },
    data: { balance: balanceAfter },
  });
};

const runInTx = async <T>(tx: TxClient | undefined, fn: (t: TxClient) => Promise<T>): Promise<T> => {
  if (tx) return fn(tx);
  return prisma.$transaction((t) => fn(t));
};

export const walletService = {
  getOrCreate,

  /**
   * Credit the wallet (positive amount lands as +amount). Idempotent when an
   * idempotencyKey is supplied. Accepts an optional tx client so the caller can
   * compose this with other writes (e.g. settlement sale credit).
   */
  async credit(args: LedgerArgs, tx?: TxClient) {
    if (args.amountDecimal.lessThanOrEqualTo(0)) {
      throw badRequest('Credit amount must be positive');
    }
    return runInTx(tx, (t) => applyLedger(t, args, args.amountDecimal));
  },

  /**
   * Debit the wallet (positive amount lands as -amount). Rejects (before any
   * write) if it would overdraw. Accepts an optional tx client.
   */
  async debit(args: LedgerArgs, tx?: TxClient) {
    if (args.amountDecimal.lessThanOrEqualTo(0)) {
      throw badRequest('Debit amount must be positive');
    }
    return runInTx(tx, (t) => applyLedger(t, args, args.amountDecimal.negated()));
  },

  async getBalance(userId: string): Promise<{ balance: string; currency: string }> {
    const wallet = await getOrCreate(userId);
    return { balance: wallet.balance.toFixed(2), currency: wallet.currency };
  },

  async listTransactions(userId: string, query: PaginationQuery) {
    const wallet = await getOrCreate(userId);
    const [rows, total] = await Promise.all([
      prisma.walletTransaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        ...skipTake(query),
      }),
      prisma.walletTransaction.count({ where: { walletId: wallet.id } }),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      type: r.type,
      amount: r.amount.toFixed(2),
      balanceAfter: r.balanceAfter.toFixed(2),
      description: r.description,
      createdAt: r.createdAt.toISOString(),
    }));
    return buildPage(items, total, query.page, query.pageSize);
  },
};
