import { prisma } from '../../lib/prisma.js';
import { conflict, notFound } from '../../utils/http-error.js';
import type { CreateReportDto, UpdateReportStatusDto } from './dto.js';

export const reportService = {
  async create(reporterId: string, auctionId: string, dto: CreateReportDto) {
    // Verify auction exists.
    const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
    if (!auction) throw notFound('Auction not found');

    // Prevent duplicate reports.
    const existing = await prisma.auctionReport.findUnique({
      where: { auctionId_reporterId: { auctionId, reporterId } },
    });
    if (existing) throw conflict('You have already reported this auction');

    return prisma.auctionReport.create({
      data: {
        auctionId,
        reporterId,
        reason: dto.reason,
        details: dto.details,
      },
      include: {
        auction: { select: { id: true, title: true } },
      },
    });
  },

  /** Admin: list all reports, newest first. */
  async listAll(statusFilter?: string) {
    const where = statusFilter ? { status: statusFilter as any } : {};
    return prisma.auctionReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        auction: { select: { id: true, title: true, status: true, seller: { select: { name: true } } } },
        reporter: { select: { id: true, name: true, email: true } },
      },
    });
  },

  /** Admin: update report status. */
  async updateStatus(reportId: string, dto: UpdateReportStatusDto) {
    const report = await prisma.auctionReport.findUnique({ where: { id: reportId } });
    if (!report) throw notFound('Report not found');

    return prisma.auctionReport.update({
      where: { id: reportId },
      data: {
        status: dto.status,
        adminNote: dto.adminNote ?? null,
      },
      include: {
        auction: { select: { id: true, title: true } },
        reporter: { select: { id: true, name: true, email: true } },
      },
    });
  },
};
