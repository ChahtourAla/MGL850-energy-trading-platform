import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private instance: PrismaClient | null = null;

  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService,
  ) {}

  /**
   * Return a shared Prisma Client for this NestJS process.
   *
   * The connection is initialized lazily, so isolated
   * unit tests do not require a running PostgreSQL server.
   */
  get client(): PrismaClient {
    if (this.instance) {
      return this.instance;
    }

    const connectionString = this.config.get<string>('DATABASE_URL');

    if (!connectionString) {
      throw new ServiceUnavailableException('PostgreSQL is not configured');
    }

    const adapter = new PrismaPg({
      connectionString,
      max: 3,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
    });

    this.instance = new PrismaClient({
      adapter,
    });

    return this.instance;
  }

  /**
   * Close Prisma's connection pool when NestJS stops.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.instance) {
      await this.instance.$disconnect();
      this.instance = null;
    }
  }
}
