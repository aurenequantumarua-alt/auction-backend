import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.$connect()
  .then(() => console.log('DB_SUCCESS'))
  .catch((e) => console.error('DB_ERROR', e.message))
  .finally(() => prisma.$disconnect());
