import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictException } from '@nestjs/common';
import * as argon2 from 'argon2';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: PrismaService;

  const mockUsers = [
    {
      id: 'uuid-1',
      name: 'Alice Buyer',
      email: 'buyer1@example.com',
      physicalAddress: "123 Rue de l'Énergie, Montréal",
      xKm: 6.73423,
      yKm: -12.5673,
      preferredEnergyType: 'SOLAR',
      reputation: 100,
      createdAt: new Date(),
    },
    {
      id: 'uuid-2',
      name: 'Bob Buyer',
      email: 'buyer2@example.com',
      physicalAddress: '456 Rue du soleil, Laval',
      xKm: 15.7423,
      yKm: 30.8373,
      preferredEnergyType: 'SOLAR',
      reputation: 100,
      createdAt: new Date(),
    },
  ];

  const mockUser = mockUsers[0];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findMany: jest.fn().mockResolvedValue(mockUsers),
              findUnique: jest.fn().mockResolvedValue(null),
              create: jest.fn().mockResolvedValue(mockUser),
            },
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should return mock users', async () => {
    const users = await service.findAll();
    expect(users).toEqual(mockUsers);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  describe('create', () => {
    it('should hash password and create a new user', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      const dto = {
        name: 'Charlie Test',
        email: 'charlie.test@example.com',
        password: 'Password123!',
      };

      const result = await service.create(dto);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: dto.email },
      });
      expect(prisma.user.create).toHaveBeenCalled();
      expect(result).toEqual(mockUser);
    });

    it('should throw ConflictException if email already exists', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const dto = {
        name: 'Charlie Test',
        email: 'charlie.test@example.com',
        password: 'Password123!',
      };

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
    });
  });
});
