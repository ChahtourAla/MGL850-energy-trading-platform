import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { UsersService } from '../users/users.service.js';
import {
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  type AccessTokenClaims,
  type AuthenticatedRequest,
} from './auth.types.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = req.headers.authorization;

    if (typeof authorization !== 'string') {
      throw new UnauthorizedException('Authentication required');
    }

    const parts = authorization.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
      throw new UnauthorizedException('Authentication required');
    }

    let payload: AccessTokenClaims;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenClaims>(parts[1], {
        algorithms: ['HS256'],
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    if (payload.tokenType !== 'access' || typeof payload.sub !== 'string' || !isUUID(payload.sub)) {
      throw new UnauthorizedException('Invalid access token');
    }

    // Database outages must not be disguised as authentication errors.
    const user = await this.users.findById(payload.sub);
    if (!user || user.accountOrigin === 'SIMULATED') {
      throw new UnauthorizedException('Invalid access token');
    }
    req.authenticatedUser = user;
    return true;
  }
}
