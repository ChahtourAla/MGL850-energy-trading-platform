import { Body, Controller, Header, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SimulationWalletAdminGuard } from './simulation-wallet-admin.guard.js';
import {
  SimulationWalletOnboardingService,
  type SimulationWalletPlan,
  type SimulationWalletStatus,
} from './simulation-wallet-onboarding.service.js';

@ApiTags('Internal - Simulation Wallets')
@Controller('internal/simulation/wallets')
@UseGuards(SimulationWalletAdminGuard)
export class SimulationWalletOnboardingController {
  constructor(
    @Inject(SimulationWalletOnboardingService)
    private readonly onboarding: SimulationWalletOnboardingService,
  ) {}

  @Post('plan')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'x-simulation-wallet-key', required: true, description: 'Separate simulation wallet administrator secret' })
  @ApiBody({ schema: { type: 'object' }, description: '{ userIds: string[] } (1–12 simulated UUIDs)' })
  @ApiOperation({ summary: 'Preview which imported SIMULATED households need Testnet wallets; no blockchain transactions' })
  @ApiOkResponse({ description: 'Public account statuses and counts; no private keys' })
  plan(@Body() body: unknown): Promise<SimulationWalletPlan> {
    return this.onboarding.plan(body);
  }

  @Post('provision')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'x-simulation-wallet-key', required: true })
  @ApiBody({ schema: { type: 'object' }, description: '{ userId, confirmation: "CREATE_TESTNET_ACCOUNT_FOR_<uuid>" }; creates at most one account' })
  @ApiOperation({ summary: 'Create ONE explicitly approved Hedera Testnet account via B07' })
  @ApiOkResponse({ description: 'Public wallet status; never exposes private keys or encrypted material' })
  provision(@Body() body: unknown): Promise<SimulationWalletStatus> {
    return this.onboarding.provision(body);
  }

  @Post('reconcile')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'x-simulation-wallet-key', required: true })
  @ApiBody({ schema: { type: 'object' }, description: '{ userId: string }' })
  @ApiOperation({ summary: 'Recover an existing B07 attempt by receipt/alias, never resubmit' })
  @ApiOkResponse({ description: 'Public wallet status after reconciliation' })
  reconcile(@Body() body: unknown): Promise<SimulationWalletStatus> {
    return this.onboarding.reconcile(body);
  }
}
