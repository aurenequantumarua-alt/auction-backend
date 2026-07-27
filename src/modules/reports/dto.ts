import { z } from 'zod';

export const CreateReportSchema = z.object({
  reason: z.enum(['FRAUD', 'COUNTERFEIT', 'MISLEADING_DESCRIPTION', 'WRONG_IMAGES', 'PROHIBITED_ITEM', 'OTHER']),
  details: z.string().min(10).max(2000).trim(),
});

export type CreateReportDto = z.infer<typeof CreateReportSchema>;

export const UpdateReportStatusSchema = z.object({
  status: z.enum(['REVIEWED', 'DISMISSED', 'ACTION_TAKEN']),
  adminNote: z.string().max(2000).trim().optional(),
});

export type UpdateReportStatusDto = z.infer<typeof UpdateReportStatusSchema>;
