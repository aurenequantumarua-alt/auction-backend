-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('FRAUD', 'COUNTERFEIT', 'MISLEADING_DESCRIPTION', 'WRONG_IMAGES', 'PROHIBITED_ITEM', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'REVIEWED', 'DISMISSED', 'ACTION_TAKEN');

-- CreateTable
CREATE TABLE "AuctionReport" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuctionReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuctionReport_status_idx" ON "AuctionReport"("status");

-- CreateIndex
CREATE INDEX "AuctionReport_auctionId_idx" ON "AuctionReport"("auctionId");

-- CreateIndex
CREATE INDEX "AuctionReport_reporterId_idx" ON "AuctionReport"("reporterId");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionReport_auctionId_reporterId_key" ON "AuctionReport"("auctionId", "reporterId");

-- AddForeignKey
ALTER TABLE "AuctionReport" ADD CONSTRAINT "AuctionReport_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionReport" ADD CONSTRAINT "AuctionReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
