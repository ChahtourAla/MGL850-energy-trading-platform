import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('UsersController (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    prisma = app.get<PrismaService>(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: {
        email: {
          startsWith: 'e2e.user.',
        },
      },
    });

    await app.close();
  });

  it('/users (GET) should return 200 and list seeded users', () => {
    return request(app.getHttpServer())
      .get('/users')
      .expect(200)
      .expect((res) => {
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(2);
        expect(res.body[0]).toHaveProperty('email');
      });
  });

  it('/users (POST) - should register a new user successfully', () => {
    const uniqueEmail = `e2e.user.${Date.now()}@example.com`;

    return request(app.getHttpServer())
      .post('/users')
      .send({
        name: 'E2E User',
        email: uniqueEmail,
        password: 'SecurePassword123!',
        preferredEnergyType: 'WIND',
      })
      .expect(201)
      .expect((res) => {
        expect(res.body).toHaveProperty('id');
        expect(res.body.email).toBe(uniqueEmail);
        expect(res.body).not.toHaveProperty('password');
        expect(res.body).not.toHaveProperty('passwordHash');
      });
  });

  it('/users (Post) -should return 400 Bad Request if password is too short', () => {
    return request(app.getHttpServer())
      .post('/users')
      .send({
        name: 'Invalid User',
        email: 'invalid@example.com',
        password: 'short',
      })
      .expect(400);
  });
});
