import { z } from 'zod';

export const SignupSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password is too long'),
  name: z.string().min(1).max(80).trim(),
});
export type SignupDto = z.infer<typeof SignupSchema>;

export const LoginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1),
});
export type LoginDto = z.infer<typeof LoginSchema>;

export const ForgotPasswordSchema = z.object({
  email: z.string().email('Enter a valid email address').toLowerCase().trim(),
});
export type ForgotPasswordDto = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  email: z.string().email('Enter a valid email address').toLowerCase().trim(),
  code: z
    .string()
    .length(6, 'Verification code must be 6 digits')
    .regex(/^\d+$/, 'Code must contain only digits'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password is too long'),
});
export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>;
