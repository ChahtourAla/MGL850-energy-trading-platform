import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ContractValidationError,
  ContractValidator,
  assertMatchingOutputAgainstInput,
  calculateTotalMicrousd,
} from './contract-validator.js';
import {
  toDeliveryRecordData,
  toEnergyRecordData,
  toMatchData,
  toUserProfileFields,
} from './contract-mappers.js';

const validator = new ContractValidator();
const fixture = (file: string): unknown => JSON.parse(
  readFileSync(new URL(`../../../../packages/shared/fixtures/${file}.sample.json`, import.meta.url), 'utf8'),
) as unknown;

const snapshot = () => structuredClone(validator.parse('energy-snapshot', fixture('energy-snapshot')));
const input = () => structuredClone(validator.parse('matching-input', fixture('matching-input')));
const output = () => structuredClone(validator.parse('matching-output', fixture('matching-output')));

describe('B05 shared JSON Schema compatibility', () => {
  it.each([
    ['user-registry', 'user-registry'],
    ['energy-snapshot', 'energy-snapshot'],
    ['matching-config', 'matching-config'],
    ['matching-input', 'matching-input'],
    ['matching-output', 'matching-output'],
    ['delivery-record', 'delivery-record'],
  ] as const)('accepts canonical %s fixture', (kind, filename) => {
    expect(validator.parse(kind, fixture(filename))).toBeDefined();
  });

  it('accepts individual user, hourly record, and match schemas', () => {
    const users = validator.parse('user-registry', fixture('user-registry'));
    const records = validator.parse('energy-snapshot', fixture('energy-snapshot'));
    const matches = validator.parse('matching-output', fixture('matching-output'));
    expect(validator.parse('user', users.users[0])).toBeDefined();
    expect(validator.parse('hourly-energy-record', records.users[0])).toBeDefined();
    expect(validator.parse('match-result', matches.matches[0])).toBeDefined();
  });

  it('rejects unknown fields (no silent property stripping)', () => {
    const payload = snapshot();
    Object.assign(payload, { extraField: 'not in schema' });
    expect(() => validator.parse('energy-snapshot', payload)).toThrow(ContractValidationError);
  });

  it('rejects imprecise JSON integers', () => {
    const payload = snapshot();
    payload.users[0].productionWh = Number.MAX_SAFE_INTEGER + 1;
    expect(() => validator.parse('energy-snapshot', payload)).toThrow(/safe JSON integer/);
  });

  it('rejects mismatched net energy even when JSON Schema passes', () => {
    const payload = snapshot();
    payload.users[0].netEnergyWh = 3999;
    expect(() => validator.parse('energy-snapshot', payload)).toThrow(/netEnergyWh mismatch/);
  });

  it('rejects duplicate users within one snapshot', () => {
    const payload = snapshot();
    payload.users[1].userId = payload.users[0].userId;
    expect(() => validator.parse('energy-snapshot', payload)).toThrow(/duplicate userId/);
  });

  it('rejects a record with a different hour', () => {
    const payload = snapshot();
    payload.users[0].timeSlot = '2026-10-17T15:00:00Z';
    expect(() => validator.parse('energy-snapshot', payload)).toThrow(/timeSlot mismatch/);
  });

  it('rejects scoring weights that do not total 1', () => {
    const payload = input();
    payload.scoringWeights.quantity = 0.1;
    expect(() => validator.parse('matching-input', payload)).toThrow(/scoringWeights must sum/);
  });

  it('rejects a false payment total', () => {
    const payload = output();
    payload.matches[0].totalAmountMicrousd = 560001;
    expect(() => validator.parse('matching-output', payload)).toThrow(/totalAmountMicrousd mismatch/);
  });

  it('rejects a duplicate matched buyer', () => {
    const payload = output();
    const duplicate = structuredClone(payload.matches[0]);
    duplicate.matchId = '99999999-9999-4999-8999-999999999999';
    payload.matches.push(duplicate);
    expect(() => validator.parse('matching-output', payload)).toThrow(/buyer matched more than once/);
  });

  it('rejects a pending delivery with energy already reported', () => {
    const payload = structuredClone(validator.parse('delivery-record', fixture('delivery-record')));
    payload.status = 'PENDING';
    expect(() => validator.parse('delivery-record', payload)).toThrow(/deliveredWh=0/);
  });
});

describe('B05 matching input -> output integrity', () => {
  it('accepts the real Python handoff fixtures', () => {
    expect(assertMatchingOutputAgainstInput(validator, output(), input()).matches).toHaveLength(1);
  });

  it('accepts a valid no-match result', () => {
    const noMatch = output();
    noMatch.matches = [];
    noMatch.unmatchedBuyerIds = [input().users[1].userId];
    expect(assertMatchingOutputAgainstInput(validator, noMatch, input()).matches).toHaveLength(0);
  });

  it('rejects output from a different snapshot', () => {
    const payload = output();
    payload.snapshotId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(() => assertMatchingOutputAgainstInput(validator, payload, input())).toThrow(/snapshotId differs/);
  });

  it('rejects a wallet mismatch', () => {
    const payload = output();
    payload.matches[0].buyerWallet = '0x9999999999999999999999999999999999999999';
    expect(() => assertMatchingOutputAgainstInput(validator, payload, input())).toThrow(/wallet mismatch/);
  });

  it('rejects an unknown buyer', () => {
    const payload = output();
    payload.matches[0].buyerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(() => assertMatchingOutputAgainstInput(validator, payload, input())).toThrow(/unknown or non-BUYER/);
  });

  it('rejects overselling even when all individual matches validate', () => {
    const originalInput = input();
    const secondBuyer = structuredClone(originalInput.users[1]);
    secondBuyer.userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    secondBuyer.recordId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    secondBuyer.evmAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    originalInput.users.push(secondBuyer);

    const originalOutput = output();
    const secondMatch = structuredClone(originalOutput.matches[0]);
    secondMatch.matchId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    secondMatch.buyerId = secondBuyer.userId;
    secondMatch.buyerWallet = secondBuyer.evmAddress;
    originalOutput.matches.push(secondMatch);
    expect(() => assertMatchingOutputAgainstInput(validator, originalOutput, originalInput)).toThrow(/oversold/);
  });
});

describe('B05 exact numeric / Prisma translation', () => {
  it('uses integer arithmetic and floor rounding', () => {
    expect(calculateTotalMicrousd(4000, 140000)).toBe(560000n);
    expect(calculateTotalMicrousd(1, 1001)).toBe(1n);
  });

  it('maps Wh and micro-USD fields to BigInt for Prisma', () => {
    const record = validator.parse('energy-snapshot', fixture('energy-snapshot')).users[0];
    const data = toEnergyRecordData(record);
    expect(data.productionWh).toBe(6000n);
    expect(data.netEnergyWh).toBe(4000n);
    expect(data.askPriceMicrousdPerKwh).toBe(140000n);
    expect(data.timeSlot.toISOString()).toBe('2026-10-17T14:00:00.000Z');
  });

  it('maps matching and delivery records to Prisma fields', () => {
    const match = validator.parse('matching-output', fixture('matching-output')).matches[0];
    const delivery = validator.parse('delivery-record', fixture('delivery-record'));
    expect(toMatchData(match).totalAmountMicrousd).toBe(560000n);
    expect(toMatchData(match).status).toBe('SELECTED');
    expect(toDeliveryRecordData(delivery).expectedWh).toBe(4000n);
  });

  it('keeps registration credentials out of user registry translation', () => {
    const user = validator.parse('user-registry', fixture('user-registry')).users[0];
    const data = toUserProfileFields(user);
    expect(data.id).toBe(user.userId);
    expect(data).not.toHaveProperty('passwordHash');
  });
});
