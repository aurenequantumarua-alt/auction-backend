-- CreateEnum
CREATE TYPE "DepositOrderStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "WalletDepositOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "razorpayOrderId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "DepositOrderStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletDepositOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletDepositOrder_razorpayOrderId_key" ON "WalletDepositOrder"("razorpayOrderId");

-- CreateIndex
CREATE INDEX "WalletDepositOrder_userId_createdAt_idx" ON "WalletDepositOrder"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "WalletDepositOrder_razorpayOrderId_idx" ON "WalletDepositOrder"("razorpayOrderId");

-- AddForeignKey
ALTER TABLE "WalletDepositOrder" ADD CONSTRAINT "WalletDepositOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
