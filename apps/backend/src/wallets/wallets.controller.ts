import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { WalletsService } from './wallets.service.js';
import type { PublicWallet } from './wallet.types.js';

@ApiTags('Wallets')
@ApiBearerAuth()
@Controller('users/me/wallet')
@UseGuards(JwtAuthGuard)
export class WalletsController {
  constructor(@Inject(WalletsService) private readonly wallets: WalletsService) {}

  private userId(req: AuthenticatedRequest): string {
    if (!req.authenticatedUser) throw new UnauthorizedException('Authentication required');
    return req.authenticatedUser.id;
  }

  @Get()
  @ApiOperation({ summary: 'Get wallet public identifiers or provisioning state' })
  @ApiOkResponse({ description: 'Public wallet status; never exposes private keys' })
  getWallet(@Req() req: AuthenticatedRequest): Promise<PublicWallet> {
    return this.wallets.getPublicWallet(this.userId(req));
  }

  @Post('provision')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 2, ttl: 900_000 } })
  @ApiOperation({ summary: 'Create a Hedera Testnet wallet once for this user' })
  provision(@Req() req: AuthenticatedRequest): Promise<PublicWallet> {
    return this.wallets.provision(this.userId(req));
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @ApiOperation({ summary: 'Query existing Hedera transaction; never create a second account' })
  reconcile(@Req() req: AuthenticatedRequest): Promise<PublicWallet> {
    return this.wallets.reconcile(this.userId(req));
  }
}
