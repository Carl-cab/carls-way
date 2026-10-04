/**
 * Canonical boundary for CAD/USD money.
 *
 * Monetary business logic uses integer minor units. Convert untrusted input or a
 * NUMERIC value at this boundary, serialize it back to a two-decimal database
 * string at the next boundary, and only convert to a JavaScript number for a
 * legacy/public display contract. This module intentionally does not configure
 * postgres.js NUMERIC parsing: fx_rates.rate is NUMERIC(18,8), not money, and
 * must retain its own precision.
 */

export const MONEY_CURRENCIES = ['CAD', 'USD'] as const;
export type MoneyCurrency = (typeof MONEY_CURRENCIES)[number];

/** A safe integer count of cents, validated at all public money boundaries. */
export type MinorUnits = number;
export type MoneyInput = string | number;

export const ZERO_MINOR_UNITS = 0 as MinorUnits;
/** Largest number of cents representable by NUMERIC(14,2). */
export const MAX_SAFE_MINOR_UNITS = 99_999_999_999_999;
/** Ledger and split columns use narrower NUMERIC(12,2). */
export const MAX_NARROW_MINOR_UNITS = 999_999_999_999;

export class MoneyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyValidationError';
  }
}

export function isMoneyCurrency(currency: unknown): currency is MoneyCurrency {
  return typeof currency === 'string' && (MONEY_CURRENCIES as readonly string[]).includes(currency);
}

export function assertMoneyCurrency(currency: unknown): asserts currency is MoneyCurrency {
  if (!isMoneyCurrency(currency)) {
    throw new MoneyValidationError('Currency must be CAD or USD.');
  }
}

function inputToDecimal(input: MoneyInput): string {
  if (typeof input === 'string') return input;
  if (!Number.isFinite(input) || Math.abs(input) > MAX_SAFE_MINOR_UNITS / 100) {
    throw new MoneyValidationError('Amount must be a finite, safe decimal value.');
  }
  // String(number) deliberately rejects scientific notation and binary artefacts
  // such as 0.30000000000000004 instead of silently rounding them into money.
  return String(input);
}

/**
 * Parse a canonical decimal amount. Whole-dollar and one-decimal JSON numbers
 * are accepted because JSON drops insignificant trailing zeroes; all output is
 * normalized to exactly two decimal places. Whitespace, signs, exponent form,
 * leading zeroes, and fractional cents are rejected.
 */
function parseDecimalToMinor(input: MoneyInput, allowNegative: boolean): number {
  const decimal = inputToDecimal(input);
  const match = decimal.match(allowNegative
    ? /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/
    : /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new MoneyValidationError(
      'Amount must be a plain decimal with no more than two fractional digits.',
    );
  }

  const negative = allowNegative && match[1] === '-';
  const whole = allowNegative ? match[2] : match[1];
  const fraction = allowNegative ? match[3] : match[2];
  const centsText = `${whole}${(fraction ?? '').padEnd(2, '0')}`;
  const cents = BigInt(centsText);
  const signed = negative ? -cents : cents;
  const max = BigInt(MAX_SAFE_MINOR_UNITS);
  if (signed > max || signed < -max) {
    throw new MoneyValidationError('Amount exceeds the supported safe minor-unit range.');
  }
  return Number(signed);
}

function asMinorUnits(value: number): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyValidationError('Amount is not a safe integer number of minor units.');
  }
  return value;
}

/** Parse a non-negative decimal string read from a money NUMERIC column. */
export function parseDatabaseMoney(input: string, currency: unknown): MinorUnits {
  assertMoneyCurrency(currency);
  const minor = parseDecimalToMinor(input, false);
  return asMinorUnits(minor);
}
/** SUM(total_amount) can be signed because velocity reversal rows are negative. */
export function parseSignedDatabaseMoney(input: string, currency: unknown): MinorUnits {
  assertMoneyCurrency(currency);
  return asMinorUnits(parseDecimalToMinor(input, true));
}

/** Parse a positive externally supplied cent amount and validate its currency. */
export function parsePositiveMoney(
  input: MoneyInput,
  currency: unknown,
  options?: { maxMinorUnits?: number },
): MinorUnits {
  assertMoneyCurrency(currency);
  const minor = parseDecimalToMinor(input, false);
  if (minor <= 0) throw new MoneyValidationError('Amount must be greater than zero.');
  const max = options?.maxMinorUnits ?? MAX_SAFE_MINOR_UNITS;
  if (!Number.isSafeInteger(max) || max < 0 || minor > max) {
    throw new MoneyValidationError('Amount exceeds the permitted maximum.');
  }
  return asMinorUnits(minor);
}

/** Parse a non-negative input used for debit/credit columns and zero values. */
export function parseNonNegativeMoney(input: MoneyInput, currency: unknown): MinorUnits {
  assertMoneyCurrency(currency);
  return asMinorUnits(parseDecimalToMinor(input, false));
}

/**
 * Render a canonical, exact NUMERIC(…,2) literal. This is the only serializer
 * money-moving code should pass to PostgreSQL for a monetary value.
 */
export function toDatabaseDecimal(minor: MinorUnits): string {
  if (!Number.isSafeInteger(minor) || minor < 0 || minor > MAX_SAFE_MINOR_UNITS) {
    throw new MoneyValidationError('Database money value must be a non-negative safe minor-unit integer.');
  }
  const whole = Math.floor(minor / 100);
  return `${whole}.${String(minor % 100).padStart(2, '0')}`;
}

/** Serialize a signed balance delta without turning it into floating point. */
export function toSignedDatabaseDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || Math.abs(minor) > MAX_SAFE_MINOR_UNITS) {
    throw new MoneyValidationError('Signed money value must be a safe minor-unit integer.');
  }
  if (minor < 0) return `-${toDatabaseDecimal(asMinorUnits(-minor))}`;
  return toDatabaseDecimal(asMinorUnits(minor));
}

/** Fail before SQL rather than let a NUMERIC(12,2) column reject a large value. */
export function toNarrowDatabaseDecimal(minor: MinorUnits): string {
  if (minor > MAX_NARROW_MINOR_UNITS) {
    throw new MoneyValidationError('Amount exceeds NUMERIC(12,2) column capacity.');
  }
  return toDatabaseDecimal(minor);
}

/** Public-contract/display conversion only. Never use this result for accounting. */
export function minorUnitsToMajorNumber(minor: number): number {
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyValidationError('Money display value must be a safe minor-unit integer.');
  }
  return minor / 100;
}

/** Exact plain display text, kept separate from database serialization. */
export function formatMoneyDisplay(minor: MinorUnits, currency: MoneyCurrency): string {
  return `${currency} ${toDatabaseDecimal(minor)}`;
}

export function compareMinorUnits(left: number, right: number): -1 | 0 | 1 {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new MoneyValidationError('Money comparison requires safe minor-unit integers.');
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

export function addMinorUnits(left: MinorUnits, right: MinorUnits): MinorUnits {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) ||
      Math.abs(left) > MAX_SAFE_MINOR_UNITS || Math.abs(right) > MAX_SAFE_MINOR_UNITS) {
    throw new MoneyValidationError('Money addition requires bounded integer minor units.');
  }
  const value = left + right;
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_SAFE_MINOR_UNITS) throw new MoneyValidationError('Money addition exceeds safe range.');
  return asMinorUnits(value);
}

export function subtractMinorUnits(left: MinorUnits, right: MinorUnits): MinorUnits {
  return addMinorUnits(left, -right);
}

/** Evenly divide cents, allocating remainder cents in input order. */
export function divideMinorUnitsEvenly(total: MinorUnits, count: number): MinorUnits[] {
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_SAFE_MINOR_UNITS ||
      !Number.isSafeInteger(count) || count <= 0 || count > 10_000) {
    throw new MoneyValidationError('Participant count must be a positive integer.');
  }
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => asMinorUnits(base + (index < remainder ? 1 : 0)));
}

/**
 * Multiply a cent amount by a non-negative decimal factor and round half up to
 * the nearest cent. Rates are parsed locally at up to eight decimal places;
 * this neither changes nor relies on postgres.js' global NUMERIC parser.
 */
export function multiplyMinorUnitsByDecimal(
  amount: MinorUnits,
  factor: string,
  maxFractionDigits: number = 8,
): MinorUnits {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_SAFE_MINOR_UNITS || typeof factor !== 'string' ||
      !Number.isInteger(maxFractionDigits) || maxFractionDigits < 1 || maxFractionDigits > 18) {
    throw new MoneyValidationError('Invalid minor-unit amount or decimal scale.');
  }
  const match = factor.match(new RegExp(`^(0|[1-9]\\d*)(?:\\.(\\d{1,${maxFractionDigits}}))?$`));
  if (!match) throw new MoneyValidationError('Rate must be a plain non-negative decimal.');
  const whole = match[1];
  const fraction = (match[2] ?? '').padEnd(maxFractionDigits, '0');
  const scale = BigInt(10) ** BigInt(maxFractionDigits);
  const scaledFactor = BigInt(`${whole}${fraction}`);
  const result = (BigInt(amount) * scaledFactor + scale / BigInt(2)) / scale;
  if (result > BigInt(MAX_SAFE_MINOR_UNITS)) {
    throw new MoneyValidationError('Converted amount exceeds the supported safe minor-unit range.');
  }
  return asMinorUnits(Number(result));
}
