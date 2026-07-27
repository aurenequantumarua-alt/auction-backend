-- CreateEnum
CREATE TYPE "PayoutMethodType" AS ENUM ('BANK', 'UPI');

-- AlterTable
ALTER TABLE "BankAccount" ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "type" "PayoutMethodType" NOT NULL DEFAULT 'BANK',
ADD COLUMN     "upiId" TEXT,
ALTER COLUMN "accountNumberLast4" DROP NOT NULL,
ALTER COLUMN "accountNumberEnc" DROP NOT NULL,
ALTER COLUMN "ifsc" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PhoneOtp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneOtp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PhoneOtp_userId_phone_createdAt_idx" ON "PhoneOtp"("userId", "phone", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "PhoneOtp" ADD CONSTRAINT "PhoneOtp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
