import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { B34FullDayController } from './b34-full-day.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';
const date=(hour:number)=>new Date(`2026-11-10T${String(hour).padStart(2,'0')}:00:00.000Z`);
const userId='11111111-1111-4111-8111-111111111111';
const db={
  user:{findMany:vi.fn(async()=>[{id:userId}])},
  energyRecord:{findMany:vi.fn(async()=>Array.from({length:24},(_,h)=>({userId,timeSlot:date(h),marketRole:'NEUTRAL'})))},
  matchingRun:{findMany:vi.fn(async()=>[{timeSlot:date(0),matchCount:0}])},
  match:{findMany:vi.fn(async()=>[])},
  v2Market:{findMany:vi.fn(async()=>[])},
  v2Allocation:{findMany:vi.fn(async()=>[])},
  b26MarketRun:{findMany:vi.fn(async()=>[])},
};
const controller=new B34FullDayController({client:db} as unknown as PrismaService);
describe('B34 day coverage safe response',()=>{
  it('requires a valid canonical UTC day',async()=>{
    await expect(controller.dayCoverage('2026-02-31')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.dayCoverage(undefined)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('distinguishes a completed zero-match run from no B12 run',async()=>{
    const v=await controller.dayCoverage('2026-11-10');
    expect(v.summary.importedHours).toBe(24);
    expect(v.summary.b12RunHours).toBe(1);
    expect(v.summary.hoursWithoutB12Run).toBe(23);
    expect(v.hours[0].state).toBe('B12_MATCHING_COMPLETED_ZERO_MATCHES');
    expect(v.hours[7].state).toBe('NO_B12_MATCHING_RUN');
    expect(v.evidenceLevel).toBe('DATABASE_RECORDED_ONLY');
    expect(v.readOnly).toBe(true);
  });
  it('scopes imported energy queries to simulated households and trusted imports',async()=>{
    await controller.dayCoverage('2026-11-10');
    expect(db.energyRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where:expect.objectContaining({snapshotImport:{isNot:null},user:{accountOrigin:'SIMULATED'}}),
    }));
  });
});
