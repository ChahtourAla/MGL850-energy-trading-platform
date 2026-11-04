import {
  Controller, Get, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { toPublicUser, type PublicUser } from './users.service.js';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return authenticated user profile' })
  @ApiOkResponse({ description: 'User profile without credential data' })
  getMe(@Req() req: AuthenticatedRequest): PublicUser {
    if (!req.authenticatedUser) {
      throw new UnauthorizedException('Authentication required');
    }
    return toPublicUser(req.authenticatedUser);
  }
}
