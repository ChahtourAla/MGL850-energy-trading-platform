import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { UsersModule } from '../users/users.module.js';
import { UsersController } from '../users/users.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from './auth.types.js';

@Module({
  imports: [
    UsersModule,
    ThrottlerModule.forRoot([{ ttl: 900_000, limit: 30 }]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_ACCESS_SECRET');
        if (!secret || secret.length < 32) {
          throw new Error('JWT_ACCESS_SECRET must contain at least 32 characters');
        }
        return {
          secret,
          signOptions: {
            algorithm: 'HS256' as const,
            expiresIn: '15m' as const,
            issuer: TOKEN_ISSUER,
            audience: TOKEN_AUDIENCE,
          },
          verifyOptions: {
            algorithms: ['HS256'] as ['HS256'],
            issuer: TOKEN_ISSUER,
            audience: TOKEN_AUDIENCE,
          },
        };
      },
    }),
  ],
  controllers: [AuthController, UsersController],
  providers: [AuthService, JwtAuthGuard],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
