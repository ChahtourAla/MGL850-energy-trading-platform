import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const AUTH_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  passwordHash: true,
  physicalAddress: true,
  xKm: true,
  yKm: true,
  preferredEnergyType: true,
  reputation: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.UserSelect;

export type AuthUser = Prisma.UserGetPayload<{
  select: typeof AUTH_USER_SELECT;
}>;

export interface PublicUser {
  userId: string;
  name: string;
  email: string;
  physicalAddress: string | null;
  xKm: number | null;
  yKm: number | null;
  preferredEnergyType: string | null;
  reputation: number;
  createdAt: string;
  updatedAt: string;
  walletStatus: 'NOT_PROVISIONED';
}

export function toPublicUser(user: AuthUser): PublicUser {
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    physicalAddress: user.physicalAddress,
    xKm: user.xKm?.toNumber() ?? null,
    yKm: user.yKm?.toNumber() ?? null,
    preferredEnergyType: user.preferredEnergyType,
    reputation: user.reputation,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    walletStatus: 'NOT_PROVISIONED',
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  findByEmail(email: string): Promise<AuthUser | null> {
    return this.prisma.client.user.findUnique({
      where: { email },
      select: AUTH_USER_SELECT,
    });
  }

  findById(id: string): Promise<AuthUser | null> {
    return this.prisma.client.user.findUnique({
      where: { id },
      select: AUTH_USER_SELECT,
    });
  }

  create(data: {
    name: string;
    email: string;
    passwordHash: string;
    physicalAddress: string;
    xKm: number;
    yKm: number;
    preferredEnergyType: string;
  }): Promise<AuthUser> {
    return this.prisma.client.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash: data.passwordHash,
        physicalAddress: data.physicalAddress,
        xKm: data.xKm.toString(),
        yKm: data.yKm.toString(),
        preferredEnergyType: data.preferredEnergyType,
        reputation: 50,
      },
      select: AUTH_USER_SELECT,
    });
  }

  async getExistingById(id: string): Promise<AuthUser> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }
}
