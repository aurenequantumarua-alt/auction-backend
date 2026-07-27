import { prisma } from '../../lib/prisma.js';

export const adminService = {
  async listAuctions() {
    return prisma.auction.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        seller: { select: { name: true, email: true } },
        currentBid: { select: { id: true, amount: true, bidderId: true, placedAt: true } },
      },
    });
  },

  async deleteAuction(id: string) {
    await prisma.auction.delete({
      where: { id },
    });
  }
};
