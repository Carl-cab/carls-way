import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { MONEY_COLUMNS } from '@/lib/db';
import type {
  DetectionResult,
  MigrationDescriptor,
  MigrationSqlExecutor,
} from '@/lib/migrations/types';

/**
 * The migrations this repository knows about, and how to tell whether a
 * database already has each one's end state.
 *
 * Only the three authorization-gated files in `migrations/` are listed. The
 * ~103 statements in `app/api/migrate/route.ts` are deliberately NOT entries
 * here: they are a convergent reconciler built from `ADD COLUMN IF NOT EXISTS`
 * and `CREATE TABLE IF NOT EXISTS`, so re-running them is the designed
 * behaviour and "has statement 47 been applied?" is not a meaningful question.
 * What that route needed was an execution record, which it now writes — see
 * `recordConvergenceRun()` in `./tracking`.
 *
 * Every `detect` here is read-only and inspects the catalogue, never data.
 */

/** sha256 of a migration file, hex. Stable across platforms: bytes in, hex out. */
export function fileChecksum(repoRoot: string, relativePath: string): string | null {
  const full = path.join(repoRoot, relativePath);
  if (!existsSync(full)) return null;
  return createHash('sha256').update(readFileSync(full)).digest('hex');
}

/**
 * Are any money columns still a float type?
 *
 * Shares `MONEY_COLUMNS` with `lib/db.ts` rather than restating the list,
 * because a fourth copy of it is exactly how this repository has previously
 * drifted. A column absent from a deployment is skipped, matching
 * `detectLegacyMoneyColumns()`.
 */
async function detectMoneyColumnsConverted(
  sql: MigrationSqlExecutor,
): Promise<DetectionResult> {
  const pairs = MONEY_COLUMNS.map(([table, column]) => `${table}.${column}`);

  const rows = await sql<{ table_name: string; column_name: string; data_type: string }>`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name || '.' || column_name) = ANY(${pairs as unknown as string[]})
  `;

  if (rows.length === 0) {
    return {
      outcome: 'unknown',
      evidence:
        'none of the money columns exist in this database, so neither converted nor unconverted is true',
    };
  }

  const floats = rows.filter(
    (r) => r.data_type === 'real' || r.data_type === 'double precision',
  );

  if (floats.length > 0) {
    return {
      outcome: 'absent',
      evidence: `still float: ${floats
        .map((r) => `${r.table_name}.${r.column_name} (${r.data_type})`)
        .join(', ')}`,
    };
  }

  return {
    outcome: 'present',
    evidence: `all ${rows.length} present money columns are non-float (${rows
      .map((r) => `${r.table_name}.${r.column_name}=${r.data_type}`)
      .join(', ')})`,
  };
}

/** Are both cross-border amount columns NUMERIC(14,2) rather than (12,2)? */
async function detectCrossBorderWidened(
  sql: MigrationSqlExecutor,
): Promise<DetectionResult> {
  const rows = await sql<{
    column_name: string;
    data_type: string;
    numeric_precision: number | null;
    numeric_scale: number | null;
  }>`
    SELECT column_name, data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transactions'
      AND column_name IN ('sender_amount', 'receiver_amount')
    ORDER BY column_name
  `;

  if (rows.length < 2) {
    return {
      outcome: 'unknown',
      evidence: `expected transactions.sender_amount and receiver_amount; found ${
        rows.length === 0 ? 'neither' : rows.map((r) => r.column_name).join(', ')
      }`,
    };
  }

  const describe = rows
    .map(
      (r) =>
        `${r.column_name}=${r.data_type}(${r.numeric_precision ?? '?'},${r.numeric_scale ?? '?'})`,
    )
    .join(', ');

  const widened = rows.every(
    (r) =>
      r.data_type === 'numeric' && r.numeric_precision === 14 && r.numeric_scale === 2,
  );

  if (widened) return { outcome: 'present', evidence: describe };

  // Scale 2 at a narrower precision is the documented pre-migration state.
  const narrow = rows.every(
    (r) => r.data_type === 'numeric' && r.numeric_scale === 2 && r.numeric_precision === 12,
  );
  if (narrow) return { outcome: 'absent', evidence: describe };

  // Anything else — float, a different scale — is not a state this migration
  // was written against, and guessing would be worse than stopping.
  return {
    outcome: 'unknown',
    evidence: `${describe}; neither NUMERIC(12,2) nor NUMERIC(14,2), which is outside what this migration handles`,
  };
}

/** Does the unique partial index on transfer_intents.correlation_id exist? */
async function detectCorrelationIndex(
  sql: MigrationSqlExecutor,
): Promise<DetectionResult> {
  const tables = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'transfer_intents'
    ) AS exists
  `;
  if (!tables[0]?.exists) {
    return {
      outcome: 'unknown',
      evidence: 'table public.transfer_intents does not exist',
    };
  }

  const rows = await sql<{ indexname: string; indexdef: string }>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'transfer_intents'
      AND indexname = 'idx_transfer_intents_correlation_id'
  `;

  if (rows.length === 0) {
    return {
      outcome: 'absent',
      evidence: 'idx_transfer_intents_correlation_id not present on public.transfer_intents',
    };
  }

  const def = rows[0].indexdef;
  // The migration creates a UNIQUE partial index. A non-unique index of the
  // same name is a different object and must not read as this migration's end
  // state — it would leave the uniqueness guarantee absent while claiming the
  // migration was done.
  if (!/UNIQUE/i.test(def)) {
    return {
      outcome: 'unknown',
      evidence: `index exists but is not UNIQUE: ${def}`,
    };
  }

  return { outcome: 'present', evidence: def };
}

export const MIGRATIONS: ReadonlyArray<MigrationDescriptor> = [
  {
    id: '20260907_money_real_to_numeric',
    file: 'migrations/20260907_money_real_to_numeric.sql',
    summary: 'Convert float money columns to NUMERIC(14,2)',
    selfTransacting: true,
    detect: detectMoneyColumnsConverted,
  },
  {
    id: '20261003_widen_transactions_cross_border_amounts',
    file: 'migrations/20261003_widen_transactions_cross_border_amounts.sql',
    summary: 'Widen transactions.sender_amount/receiver_amount to NUMERIC(14,2)',
    selfTransacting: true,
    detect: detectCrossBorderWidened,
  },
  {
    id: '20261004_early_webhook_metadata_correlation',
    file: 'migrations/20261004_early_webhook_metadata_correlation.sql',
    summary: 'Unique partial index on transfer_intents.correlation_id',
    selfTransacting: true,
    detect: detectCorrelationIndex,
  },
] as const;

/** Look up a descriptor, or undefined for an id this repository does not know. */
export function findMigration(id: string): MigrationDescriptor | undefined {
  return MIGRATIONS.find((m) => m.id === id);
}
