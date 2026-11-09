import { hash, verify } from '@node-rs/argon2';
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '../generated/prisma/client.js';
import { UsersService, toPublicUser, type PublicUser } from '../users/users.service.js';
import type { RegisterDto } from './dto/register.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { AccessTokenClaims } from './auth.types.js';

export interface RegistrationResult {
  user: PublicUser;
}

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: 900;
  user: PublicUser;
}

export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(UsersService)
    private readonly users: UsersService,
    @Inject(JwtService)
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<RegistrationResult> {
    const email = normalizeEmail(dto.email);

    if (await this.users.findByEmail(email)) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await hash(dto.password, {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    });

    try {
      const user = await this.users.create({
        email,
        name: dto.name.trim(),
        passwordHash,
        physicalAddress: dto.physicalAddress.trim(),
        xKm: dto.xKm,
        yKm: dto.yKm,
        preferredEnergyType: dto.preferredEnergyType,
      });
      return { user: toPublicUser(user) };
    } catch (error: unknown) {
      // The pre-check is not enough under concurrent requests.
      // PostgreSQL's unique constraint is the final authority.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email already registered');
      }
      throw error;
    }
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const email = normalizeEmail(dto.email);
    const user = await this.users.findByEmail(email);

    // Burn comparable Argon2 work for nonexistent users. Do not reveal
    // whether an email address is registered.
    if (!user || user.accountOrigin === 'SIMULATED') {
      await hash(dto.password, {
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    let passwordMatches = false;
    try {
      passwordMatches = await verify(user.passwordHash, dto.password);
    } catch {
      // A corrupt hash must not be exposed to the client.
      passwordMatches = false;
    }
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const claims: AccessTokenClaims = { sub: user.id, tokenType: 'access' };
    const accessToken = await this.jwt.signAsync(claims);
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: 900,
      user: toPublicUser(user),
    };
  }
}
