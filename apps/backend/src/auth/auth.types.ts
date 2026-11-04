import type { Request } from 'express';
import type { AuthUser } from '../users/users.service.js';

export interface AuthenticatedRequest extends Request {
  authenticatedUser?: AuthUser;
}

export interface AccessTokenClaims {
  sub: string;
  tokenType: 'access';
  iat?: number;
  exp?: number;
}

export const TOKEN_ISSUER = 'mgl850-energy-backend';
export const TOKEN_AUDIENCE = 'mgl850-energy-users';
