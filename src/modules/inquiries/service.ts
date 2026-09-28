import { prisma } from '../../lib/prisma.js';
import { forbidden, notFound, badRequest } from '../../utils/http-error.js';
import { notificationService } from '../notifications/service.js';
import { realtime } from '../../realtime/gateway.js';
import type { AskQuestionDto, AnswerQuestionDto } from './dto.js';

/**
 * Regex that catches phone numbers (5+ consecutive digits, optionally separated
 * by dashes/spaces) and email addresses. Used to block disintermediation.
 */
const CONTACT_INFO_RE =
  /(\b[\w.+-]+@[\w-]+\.[\w.]+\b)|(\+?\d[\d\s\-().]{4,}\d)/gi;

const sanitise = (text: string): string => {
  if (CONTACT_INFO_RE.test(text)) {
    throw badRequest(
      'Questions and answers may not contain email addresses or phone numbers. Please use the platform to communicate.',
    );
  }
  return text;
};

const INQUIRY_INCLUDE = {
  asker: { select: { id: true, name: true, avatarUrl: true } },
} as const;

export const inquiryService = {
  /** List all inquiries for an auction (pinned first, then newest). */
  async list(auctionId: string) {
    const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
    if (!auction) throw notFound('Auction not found');

    return prisma.auctionInquiry.findMany({
      where: { auctionId },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      include: INQUIRY_INCLUDE,
    });
  },

  /** Buyer asks a question on an auction. */
  async ask(askerId: string, auctionId: string, dto: AskQuestionDto) {
    const auction = await prisma.auction.findUnique({ where: { id: auctionId } });
    if (!auction) throw notFound('Auction not found');
    if (auction.sellerId === askerId) {
      throw forbidden('You cannot ask questions on your own listing');
    }

    const question = sanitise(dto.question);

    const inquiry = await prisma.auctionInquiry.create({
      data: { auctionId, askerId, question },
      include: INQUIRY_INCLUDE,
    });

    // Notify seller of new question.
    await notificationService.notify(prisma, {
      userId: auction.sellerId,
      type: 'NEW_INQUIRY',
      payload: {
        auctionId,
        auctionTitle: auction.title,
        inquiryId: inquiry.id,
        question: inquiry.question.slice(0, 120),
      },
    });

    // Push real-time event to auction room so other viewers see it.
    realtime.emitInquiryNew(auctionId, {
      ...inquiry,
      createdAt: inquiry.createdAt.toISOString(),
      answeredAt: inquiry.answeredAt ? inquiry.answeredAt.toISOString() : null,
    });

    return inquiry;
  },

  /** Seller answers a question. */
  async answer(sellerId: string, inquiryId: string, dto: AnswerQuestionDto) {
    const inquiry = await prisma.auctionInquiry.findUnique({
      where: { id: inquiryId },
      include: { auction: true },
    });
    if (!inquiry) throw notFound('Inquiry not found');
    if (inquiry.auction.sellerId !== sellerId) {
      throw forbidden('Only the seller can answer questions');
    }

    const answer = sanitise(dto.answer);
    if (dto.imageUrl) sanitise(dto.imageUrl);

    const updated = await prisma.auctionInquiry.update({
      where: { id: inquiryId },
      data: {
        answer,
        imageUrl: dto.imageUrl ?? null,
        answeredAt: new Date(),
      },
      include: INQUIRY_INCLUDE,
    });

    // Notify the asker that their question was answered.
    await notificationService.notify(prisma, {
      userId: inquiry.askerId,
      type: 'INQUIRY_ANSWERED',
      payload: {
        auctionId: inquiry.auctionId,
        auctionTitle: inquiry.auction.title,
        inquiryId: inquiry.id,
        answerPreview: answer.slice(0, 120),
      },
    });

    realtime.emitInquiryAnswered(inquiry.auctionId, {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      answeredAt: updated.answeredAt ? updated.answeredAt.toISOString() : null,
    });

    return updated;
  },

  /** Seller pins/unpins a question. */
  async togglePin(sellerId: string, inquiryId: string) {
    const inquiry = await prisma.auctionInquiry.findUnique({
      where: { id: inquiryId },
      include: { auction: true },
    });
    if (!inquiry) throw notFound('Inquiry not found');
    if (inquiry.auction.sellerId !== sellerId) {
      throw forbidden('Only the seller can pin questions');
    }

    return prisma.auctionInquiry.update({
      where: { id: inquiryId },
      data: { isPinned: !inquiry.isPinned },
      include: INQUIRY_INCLUDE,
    });
  },
};
