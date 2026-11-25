import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service.js';
import { TradingApiAdminGuard } from '../trading-api/trading-api-admin.guard.js';

@ApiTags('B27 - Presenter Demo')
@ApiHeader({ name: 'x-trading-read-key', required: true })
@Controller('internal/v2/demo')
@UseGuards(TradingApiAdminGuard)
export class B27DemoController {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  private parseUtc(value: unknown, label: string): Date {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    ) {
      throw new BadRequestException(`${label} must be a UTC ISO timestamp`);
    }

    const result = new Date(value);

    if (
      !Number.isFinite(result.getTime()) ||
      ![result.toISOString(), result.toISOString().replace('.000Z', 'Z')].includes(value)
    ) {
      throw new BadRequestException(`Invalid ${label}`);
    }

    return result;
  }

  @Get('users')
  @Header('Cache-Control', 'no-store')
  async listUsers() {
    const users = await this.prisma.client.user.findMany({
      where: { accountOrigin: 'SIMULATED' },
      select: {
        id: true,
        name: true,
        preferredEnergyType: true,
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 200,
    });

    return {
      mode: 'SIMULATION',
      users: users.map((user) => ({
        userId: user.id,
        name: user.name,
        energyType: user.preferredEnergyType,
      })),
    };
  }

  @Get('users/:userId/energy')
  @Header('Cache-Control', 'no-store')
  async energyHistory(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const start = this.parseUtc(from, 'from');
    const end = this.parseUtc(to, 'to');

    if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > 31 * 86400000) {
      throw new BadRequestException('Time range must be greater than zero and at most 31 days');
    }

    const user = await this.prisma.client.user.findFirst({
      where: {
        id: userId,
        accountOrigin: 'SIMULATED',
      },
      select: { id: true, name: true },
    });

    if (!user) {
      throw new NotFoundException('Demo household not found');
    }

    const measurements = await this.prisma.client.v2SnapshotMeasurement.findMany({
      where: {
        userId,
        snapshot: {
          status: 'FINALIZED',
          intervalStart: { gte: start, lt: end },
          market: {
            namespace: 'hourly',
            mode: 'HOURLY',
          },
          corrections: {
            none: { status: 'FINALIZED' },
          },
        },
      },
      select: {
        productionWh: true,
        consumptionWh: true,
        snapshot: {
          select: {
            id: true,
            intervalStart: true,
            intervalEnd: true,
          },
        },
      },
      orderBy: {
        snapshot: { intervalStart: 'asc' },
      },
      take: 745,
    });

    if (measurements.length > 744) {
      throw new ConflictException('Unexpected duplicate hourly measurements');
    }

    // Query both trusted sources independently. A finalized V2 snapshot for
    // ONE hour must not hide imported readings from the OTHER hours.
    // Never sum two readings for the same UTC hour: finalized V2 is authoritative.
    const legacyRecords = await this.prisma.client.energyRecord.findMany({
      where: {
        userId,
        timeSlot: {
          gte: start,
          lt: end,
        },
        snapshotId: { not: null },
        snapshotImport: { isNot: null },
      },
      select: {
        snapshotId: true,
        timeSlot: true,
        productionWh: true,
        consumptionWh: true,
      },
      orderBy: { timeSlot: 'asc' },
      take: 745,
    });

    if (legacyRecords.length > 744) {
      throw new ConflictException('Too many historical hourly measurements');
    }

    const v2Hours = measurements.map((item) => ({
      snapshotId: item.snapshot.id,
      intervalStart: item.snapshot.intervalStart,
      intervalEnd: item.snapshot.intervalEnd,
      productionWh: item.productionWh,
      consumptionWh: item.consumptionWh,
      source: 'STORED_FINALIZED_HOURLY_SNAPSHOT' as const,
    }));

    const v2TimeSlots = new Set<string>();
    for (const item of v2Hours) {
      const key = item.intervalStart.toISOString();
      if (v2TimeSlots.has(key)) {
        throw new ConflictException('Multiple finalized V2 readings for the same UTC hour');
      }
      v2TimeSlots.add(key);
    }

    const legacyHours = legacyRecords
      .filter((item) => !v2TimeSlots.has(item.timeSlot.toISOString()))
      .map((item) => ({
        snapshotId: item.snapshotId!,
        intervalStart: item.timeSlot,
        intervalEnd: new Date(item.timeSlot.getTime() + 60 * 60 * 1000),
        productionWh: item.productionWh,
        consumptionWh: item.consumptionWh,
        source: 'TRUSTED_IMPORTED_LEGACY_ENERGY_RECORD' as const,
      }));

    const readings = [...v2Hours, ...legacyHours].sort(
      (a, b) => a.intervalStart.getTime() - b.intervalStart.getTime(),
    );
    if (readings.length > 744) {
      throw new ConflictException('Too many unique historical hourly measurements');
    }

    let totalProduction = 0n;
    let totalConsumption = 0n;

    const hours = readings.map((item) => {
      const production = item.productionWh;
      const consumption = item.consumptionWh;
      const net = production - consumption;

      totalProduction += production;
      totalConsumption += consumption;

      return {
        snapshotId: item.snapshotId,
        source: item.source,
        intervalStart: item.intervalStart.toISOString(),
        intervalEnd: item.intervalEnd.toISOString(),
        productionWh: production.toString(),
        consumptionWh: consumption.toString(),
        netEnergyWh: net.toString(),
        role: net > 0n ? 'SELLER' : net < 0n ? 'BUYER' : 'NEUTRAL',
      };
    });

    return {
      simulationOnly: true,
      source: v2Hours.length > 0 && legacyHours.length > 0
        ? 'MIXED_FINALIZED_V2_AND_TRUSTED_IMPORTED_LEGACY_HOURS'
        : v2Hours.length > 0
          ? 'STORED_FINALIZED_HOURLY_SNAPSHOTS'
          : 'TRUSTED_IMPORTED_LEGACY_ENERGY_RECORDS',
      user,
      from: start.toISOString(),
      to: end.toISOString(),
      totals: {
        productionWh: totalProduction.toString(),
        consumptionWh: totalConsumption.toString(),
        netEnergyWh: (totalProduction - totalConsumption).toString(),
        recordedHours: hours.length,
      },
      hours,
    };
  }
}
