import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { HederaWalletGateway } from './hedera-wallet.gateway.js';
import { WalletCryptoService } from './wallet-crypto.service.js';
import { WalletsService } from './wallets.service.js';

// WalletsController is registered in AuthModule so it can consume JwtAuthGuard
// without introducing an AuthModule <-> WalletsModule circular import.
@Module({
  imports: [PrismaModule],
  providers: [WalletsService, HederaWalletGateway, WalletCryptoService],
  exports: [WalletsService],
})
export class WalletsModule {}
