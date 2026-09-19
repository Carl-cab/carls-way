const postgres = require('postgres');

const sql = postgres({
  host: '/var/run/postgresql',
  database: 'manna_test',
  username: 'postgres',
  ssl: false,
  prepare: false,
  types: {
    numeric: {
      to: 1700,
      from: [1700],
      serialize: (x) => x.toString(),
      parse: (x) => parseFloat(x),
    },
  },
});

async function main() {
  await sql.unsafe('DROP TABLE IF EXISTS numeric_parser_probe');
  await sql.unsafe('CREATE TABLE numeric_parser_probe (amount NUMERIC(14,2) NOT NULL, fx_rate NUMERIC(18,8) NOT NULL)');

  const inserted = [
    '0.01',
    '99.99',
    '123456.78',
    '131072.02',
    '999999999999.99',
  ];

  for (const amount of inserted) {
    await sql`INSERT INTO numeric_parser_probe (amount, fx_rate) VALUES (${amount}, ${'9999999999.99999999'})`;
  }

  const rows = await sql`SELECT amount, fx_rate FROM numeric_parser_probe ORDER BY amount`;
  const roundTrips = rows.map(({ amount }) => ({
    value: amount,
    type: typeof amount,
    cents: Math.round(amount * 100),
    serialized: amount.toString(),
    fxRate: rows.find((row) => row.amount === amount)?.fx_rate,
    fxRateSerialized: rows.find((row) => row.amount === amount)?.fx_rate?.toString(),
  }));

  const arithmetic = 0.1 + 0.2;
  console.log(JSON.stringify({ roundTrips, arithmetic, arithmeticSerialized: arithmetic.toString() }, null, 2));

  await sql.unsafe('DROP TABLE numeric_parser_probe');
  await sql.end({ timeout: 5 });
}

main().catch(async (error) => {
  console.error(error);
  try { await sql.end({ timeout: 5 }); } catch {}
  process.exit(1);
});
