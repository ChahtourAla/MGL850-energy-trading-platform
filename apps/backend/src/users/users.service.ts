import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import * as argon2 from 'argon2';
import type { User } from '@energy/database';

export type UserResponse = Pick<
  User,
  | 'id'
  | 'name'
  | 'email'
  | 'physicalAddress'
  | 'xKm'
  | 'yKm'
  | 'preferredEnergyType'
  | 'reputation'
  | 'createdAt'
>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createUserDto: CreateUserDto): Promise<UserResponse> {
    const { password, ...userData } = createUserDto;

    const existingUser = await this.prisma.user.findUnique({
      where: { email: userData.email },
    });

    if (existingUser) {
      throw new ConflictException('Un utilisateur avec cet email existe déjà.');
    }

    const passwordHash = await argon2.hash(password);

    // TODO: add the wallet
    return this.prisma.user.create({
      data: {
        ...userData,
        passwordHash,
      },
      select: {
        id: true,
        name: true,
        email: true,
        physicalAddress: true,
        xKm: true,
        yKm: true,
        preferredEnergyType: true,
        reputation: true,
        createdAt: true,
      },
    });
  }

  async findAll() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        preferredEnergyType: true,
        reputation: true,
        createdAt: true,
      },
    });
  }
}
