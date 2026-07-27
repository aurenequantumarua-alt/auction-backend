import { Prisma } from '@prisma/client';

/**
 * Normalize anything that came in as a number/string into a Prisma.Decimal.
 * We never use floats in app code; everything goes through this gate.
 */
export const toDecimal = (value: number | string | Prisma.Decimal): Prisma.Decimal =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);

export const decimalToString = (d: Prisma.Decimal): string => d.toFixed(2);
