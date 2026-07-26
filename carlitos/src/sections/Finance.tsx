import { AlertTriangle, Info, Landmark, Lock, TrendingUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { useAsync } from '@/hooks/useAsync'
import { getFinance } from '@/lib/mock'
import { cn, formatCurrency, timeAgo } from '@/lib/utils'
import type { AccountType } from '@/types'

const typeLabel: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit',
  brokerage: 'Brokerage',
  crypto: 'Crypto',
}

export function Finance() {
  const { data, loading } = useAsync(getFinance)

  if (loading || !data) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Finance" subtitle="Read-only aggregation across your accounts." />
        <div className="grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Finance"
        subtitle="Read-only aggregation via Plaid. Carlitos advises — it never moves money."
        actions={
          <Badge variant="success">
            <Lock className="h-3 w-3" /> Read-only
          </Badge>
        }
      />

      {/* Net worth header */}
      <Card className="mb-6 overflow-hidden">
        <CardContent className="flex flex-wrap items-center justify-between gap-6 p-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Total net worth
            </p>
            <p className="mt-1 font-display text-4xl font-bold">
              {formatCurrency(data.netWorth, data.currency)}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-sm text-success">
              <TrendingUp className="h-4 w-4" /> ▲ {data.netWorthChangePct}% this week
            </p>
          </div>
          <div className="grid grid-cols-3 gap-6 text-right">
            {(['brokerage', 'crypto', 'savings'] as const).map((t) => {
              const total = data.accounts
                .filter((a) => a.type === t)
                .reduce((n, a) => n + a.balance, 0)
              return (
                <div key={t}>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {typeLabel[t]}
                  </p>
                  <p className="mt-1 font-display text-lg font-semibold">
                    {formatCurrency(total, data.currency)}
                  </p>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Alerts */}
      {data.alerts.length > 0 && (
        <div className="mb-6 space-y-2">
          {data.alerts.map((alert) => (
            <div
              key={alert.id}
              className={cn(
                'flex items-center gap-2.5 rounded-md border px-3.5 py-2.5 text-sm',
                alert.level === 'warning'
                  ? 'border-warning/30 bg-warning/10 text-warning'
                  : 'border-border bg-secondary/40 text-muted-foreground',
              )}
            >
              {alert.level === 'warning' ? (
                <AlertTriangle className="h-4 w-4 shrink-0" />
              ) : (
                <Info className="h-4 w-4 shrink-0" />
              )}
              {alert.message}
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Accounts */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Accounts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.accounts.map((acc) => (
              <div
                key={acc.id}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent/50"
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-9 w-9 place-items-center rounded-md bg-secondary">
                    <Landmark className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{acc.institution}</p>
                    <p className="text-xs text-muted-foreground">
                      {acc.name} · ••{acc.mask}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p
                    className={cn(
                      'font-display text-sm font-semibold',
                      acc.balance < 0 && 'text-destructive',
                    )}
                  >
                    {formatCurrency(acc.balance, acc.currency)}
                  </p>
                  <Badge variant="muted" className="mt-1">
                    {typeLabel[acc.type]}
                  </Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Budgets */}
        <Card>
          <CardHeader>
            <CardTitle>Budgets</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.budgets.map((b) => {
              const pct = Math.round((b.spent / b.limit) * 100)
              const over = pct >= 90
              return (
                <div key={b.category}>
                  <div className="mb-1.5 flex items-center justify-between text-sm">
                    <span>{b.category}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatCurrency(b.spent)} / {formatCurrency(b.limit)}
                    </span>
                  </div>
                  <Progress
                    value={pct}
                    indicatorClassName={over ? 'bg-warning' : undefined}
                  />
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>

      {/* Recent transactions */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent transactions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {data.recentTransactions.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{tx.merchant}</p>
                  <p className="text-xs text-muted-foreground">
                    {tx.category} · {timeAgo(tx.date)}
                  </p>
                </div>
                <p
                  className={cn(
                    'shrink-0 font-mono text-sm',
                    tx.amount > 0 ? 'text-success' : 'text-foreground',
                  )}
                >
                  {tx.amount > 0 ? '+' : ''}
                  {formatCurrency(tx.amount, tx.currency)}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
