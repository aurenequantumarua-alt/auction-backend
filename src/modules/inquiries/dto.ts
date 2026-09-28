import { z } from 'zod';

export const AskQuestionSchema = z.object({
  question: z
    .string()
    .min(5, 'Question must be at least 5 characters')
    .max(500, 'Question must be at most 500 characters')
    .trim(),
});
export type AskQuestionDto = z.infer<typeof AskQuestionSchema>;

export const AnswerQuestionSchema = z.object({
  answer: z
    .string()
    .min(1, 'Answer must not be empty')
    .max(1000, 'Answer must be at most 1000 characters')
    .trim(),
  imageUrl: z.string().url().optional(),
});
export type AnswerQuestionDto = z.infer<typeof AnswerQuestionSchema>;
