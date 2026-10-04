import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { getLedgerBalance } from '@/lib/ledger';
import { minorUnitsToMajorNumber, parseDatabaseMoney, subtractMinorUnits } from '@/lib/money';

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
    const actualBalanceCAD = parseDatabaseMoney(userRow.balance_cad as string, 'CAD');
    const actualBalanceUSD = parseDatabaseMoney(userRow.balance_usd as string, 'USD');

    // Get computed ledger balances
    const ledgerBalanceCAD = await getLedgerBalance(user.userId, 'CAD');
    const ledgerBalanceUSD = await getLedgerBalance(user.userId, 'USD');

    // Public fields remain display numbers; comparison and differences use cents.
    const cadMatches = actualBalanceCAD === ledgerBalanceCAD;
    const usdMatches = actualBalanceUSD === ledgerBalanceUSD;

    const results: BalanceCheckResult[] = [
      {
        userId: user.userId,
        currency: 'CAD',
        userBalance: minorUnitsToMajorNumber(actualBalanceCAD),
        ledgerBalance: minorUnitsToMajorNumber(ledgerBalanceCAD),
        matches: cadMatches,
        difference: minorUnitsToMajorNumber(subtractMinorUnits(actualBalanceCAD, ledgerBalanceCAD)),
      },
      {
        userId: user.userId,
        currency: 'USD',
        userBalance: minorUnitsToMajorNumber(actualBalanceUSD),
        ledgerBalance: minorUnitsToMajorNumber(ledgerBalanceUSD),
        matches: usdMatches,
        difference: minorUnitsToMajorNumber(subtractMinorUnits(actualBalanceUSD, ledgerBalanceUSD)),
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
