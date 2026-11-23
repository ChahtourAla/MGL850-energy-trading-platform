/**
 * B28 pricing policy PROTOTYPE. Pure calculations only.
 * Not wired to the V2 matcher, database writer, or Hedera executor.
 * Keep B22/B25 EXACT_ONLY behavior unchanged.
 * Compute monetary amounts as positive integer TEUSD base units (6 decimals).
 */

export const B28_POLICY = 'b28-teusd-half-even-1';
export const B22_LEGACY_POLICY = 'b22-exact-only-1';
const DENOMINATOR = 1000n; // Wh * microUSD/kWh -> microUSD (1 TEUSD base unit)
const UINT256_MAX = (1n << 256n) - 1n;

function positiveBigInt(value, label) {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))) {
    throw new TypeError(`${label} must be a positive decimal integer string or BigInt; never a JS Number`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > UINT256_MAX) throw new RangeError(`${label} is not a positive uint256`);
  return parsed;
}

export function quoteTeusd({quantityWh, unitPriceMicrousdPerKwh, policy = B28_POLICY}) {
  if (policy !== B28_POLICY && policy !== B22_LEGACY_POLICY) throw new Error('Unsupported pricing policy');
  const wh = positiveBigInt(quantityWh, 'quantityWh');
  const unitPrice = positiveBigInt(unitPriceMicrousdPerKwh, 'unitPriceMicrousdPerKwh');
  const numerator = wh * unitPrice;
  if (numerator > UINT256_MAX) throw new RangeError('Payment numerator exceeds uint256');
  const truncated = numerator / DENOMINATOR;
  const remainder = numerator % DENOMINATOR;
  if (policy === B22_LEGACY_POLICY && remainder !== 0n) {
    throw new Error('LEGACY_EXACT_PAYMENT_REQUIRED');
  }
  // Round to nearest 10^-6 TEUSD. Exactly-half ties go to the EVEN base unit.
  const increase = policy === B28_POLICY &&
    (remainder > 500n || (remainder === 500n && truncated % 2n === 1n));
  const rounded = truncated + (increase ? 1n : 0n);
  if (rounded <= 0n) throw new RangeError('Payment rounds to zero base units');
  if (rounded > UINT256_MAX) throw new RangeError('Rounded payment exceeds uint256');
  const difference = rounded * DENOMINATOR - numerator;
  if (policy === B28_POLICY && (difference < -500n || difference > 500n)) {
    throw new Error('Rounding error exceeds half of one TEUSD base unit');
  }
  return Object.freeze({
    policy,
    quantityWh: wh.toString(),
    unitPriceMicrousdPerKwh: unitPrice.toString(),
    numeratorWhTimesPrice: numerator.toString(),
    amountBaseUnits: rounded.toString(),
    legacyFloorBaseUnits: truncated.toString(),
    remainderOf1000: remainder.toString(),
    roundedUpFromFloor: Boolean(increase),
    errorNumeratorOf1000BaseUnits: difference.toString(),
    exactPayment: remainder === 0n,
    tokenDecimals: 6,
  });
}
