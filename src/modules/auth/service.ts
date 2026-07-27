import argon2 from 'argon2';
import { prisma } from '../../lib/prisma.js';
import { conflict, unauthorized, badRequest } from '../../utils/http-error.js';
import { otpService } from '../otp/service.js';
import {
  hashRefreshToken,
  issueRefreshToken,
  signAccessToken,
} from './tokens.js';
import type { LoginDto, SignupDto } from './dto.js';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface AuthResult {
  user: {
    id: string;
    email: string;
    name: string;
    role: 'USER' | 'ADMIN';
    avatarUrl: string | null;
  };
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const toPublicUser = (u: {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
  avatarUrl: string | null;
}) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  avatarUrl: u.avatarUrl,
});

const issueSession = async (
  user: { id: string; email: string; name: string; role: 'USER' | 'ADMIN'; avatarUrl: string | null },
  deviceInfo?: string,
): Promise<AuthResult> => {
  const refresh = issueRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refresh.hash,
      expiresAt: refresh.expiresAt,
      deviceInfo: deviceInfo ?? null,
    },
  });
  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  return {
    user: toPublicUser(user),
    accessToken,
    refreshToken: refresh.raw,
    refreshExpiresAt: refresh.expiresAt,
  };
};

export const authService = {
  async signup(dto: SignupDto, deviceInfo?: string) {
    const existing = await prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      if (!existing.emailVerified) {
        await otpService.requestEmail(existing.id, existing.email);
        return { requiresEmailVerification: true, email: existing.email };
      }
      throw conflict('An account with that email already exists');
    }

    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);
    const user = await prisma.user.create({
      data: { email: dto.email, name: dto.name, passwordHash },
    });

    await otpService.requestEmail(user.id, user.email);
    return { requiresEmailVerification: true, email: user.email };
  },

  async login(dto: LoginDto, deviceInfo?: string) {
    const user = await prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) throw unauthorized('Invalid email or password');
    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) throw unauthorized('Invalid email or password');

    if (!user.emailVerified && user.role !== 'ADMIN') {
      await otpService.requestEmail(user.id, user.email);
      return { requiresEmailVerification: true, email: user.email };
    }

    return issueSession(user, deviceInfo);
  },

  async verifyEmail(email: string, code: string, deviceInfo?: string): Promise<AuthResult> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw badRequest('User not found');
    if (user.emailVerified) throw badRequest('Email already verified');

    await otpService.verifyEmail(user.id, user.email, code);

    const verifiedUser = await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });

    return issueSession(verifiedUser, deviceInfo);
  },

  async refresh(rawToken: string, deviceInfo?: string): Promise<AuthResult> {
    const tokenHash = hashRefreshToken(rawToken);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw unauthorized('Refresh token is invalid or expired');
    }

    // Rotation: invalidate the old refresh token and issue a fresh one.
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return issueSession(stored.user, deviceInfo);
  },

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const tokenHash = hashRefreshToken(rawToken);
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async me(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw unauthorized();
    return toPublicUser(user);
  },
};
