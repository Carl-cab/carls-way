import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { getLedgerBalance } from '@/lib/ledger';

interface BalanceCheckResult {
  userId: number;
  currency: string;
  userBalance: number;
  ledgerBalance: number;
  matches: boolean;
  difference: number;
}

export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sql = getSql();

    // Get user's actual balances
    const userRows = await sql`
      SELECT balance_cad, balance_usd FROM users WHERE id = ${user.userId}
    `;

    if (!userRows[0]) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const userRow = userRows[0];
    const actualBalanceCAD = parseFloat(String(userRow.balance_cad));
    const actualBalanceUSD = parseFloat(String(userRow.balance_usd));

    // Get computed ledger balances
    const ledgerBalanceCAD = await getLedgerBalance(user.userId, 'CAD');
    const ledgerBalanceUSD = await getLedgerBalance(user.userId, 'USD');

    // Compare (allow for floating point rounding errors)
    const tolerance = 0.01;
    const cadMatches = Math.abs(actualBalanceCAD - ledgerBalanceCAD) < tolerance;
    const usdMatches = Math.abs(actualBalanceUSD - ledgerBalanceUSD) < tolerance;

    const results: BalanceCheckResult[] = [
      {
        userId: user.userId,
        currency: 'CAD',
        userBalance: actualBalanceCAD,
        ledgerBalance: ledgerBalanceCAD,
        matches: cadMatches,
        difference: actualBalanceCAD - ledgerBalanceCAD,
      },
      {
        userId: user.userId,
        currency: 'USD',
        userBalance: actualBalanceUSD,
        ledgerBalance: ledgerBalanceUSD,
        matches: usdMatches,
        difference: actualBalanceUSD - ledgerBalanceUSD,
      },
    ];

    const allMatch = cadMatches && usdMatches;

    return NextResponse.json({
      allMatch,
      results,
      warning: !allMatch ? 'Balance mismatch detected. Ledger may be incomplete or out of sync.' : null,
    });
  } catch (err) {
    console.error('Balance check error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
