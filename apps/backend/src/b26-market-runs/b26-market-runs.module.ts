import {B26AdminController} from './b26-admin.controller.js';
import {B26AdminService} from './b26-admin.service.js';
import {B26AdminGuard} from './b26-admin.guard.js';
import {Module} from '@nestjs/common';
import {ConfigModule} from '@nestjs/config';
import {TradingApiAdminGuard} from '../trading-api/trading-api-admin.guard.js';
import {B26MarketRunsController} from './b26-market-runs.controller.js';
import {B26MarketRunsService} from './b26-market-runs.service.js';
@Module({imports:[ConfigModule],controllers:[B26MarketRunsController,B26AdminController],providers:[B26MarketRunsService,TradingApiAdminGuard,B26AdminService,B26AdminGuard]})
export class B26MarketRunsModule {}
