import pg from 'pg';

import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import type { Pool } from 'pg';

export type DatabaseStatus = 'connected' | 'unavailable' | 'not_configured';

/**
 * Lightweight PostgreSQL connectivity service.
 *
 * B03 uses node-postgres to verify that SQL queries
 * can reach the configured PostgreSQL database.
 *
 * B04 will introduce Prisma for application data.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  private readonly pool: Pool | null;

  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService,
  ) {
    const connectionString = this.config.get<string>('DATABASE_URL');

    if (!connectionString) {
      this.pool = null;
      return;
    }

    this.pool = new pg.Pool({
      connectionString,
      max: 3,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
    });

    // An idle PostgreSQL client can emit an error
    // if its connection is interrupted.
    this.pool.on('error', () => {
      this.logger.warn('PostgreSQL idle connection was interrupted');
    });
  }

  /**
   * Check connectivity with an actual SQL statement.
   *
   * Never return raw connection errors to API callers,
   * because they may contain database configuration.
   */
  async checkConnection(): Promise<DatabaseStatus> {
    if (!this.pool) {
      return 'not_configured';
    }

    try {
      const result = await this.pool.query<{
        connected: number;
      }>('SELECT 1 AS connected');

      return result.rows[0]?.connected === 1 ? 'connected' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  /**
   * Close connections when NestJS shuts down.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }
}
