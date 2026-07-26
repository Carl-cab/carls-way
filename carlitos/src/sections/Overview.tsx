import { Activity, Bot, CheckCircle2, Cpu, ShieldCheck, TrendingUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StatusDot } from '@/components/StatusDot'
import { SourceIcon } from '@/components/SourceIcon'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { useAsync } from '@/hooks/useAsync'
import { getActivity, getAgents, getFinance, getRuntimeStatus, getSources } from '@/lib/mock'
import { agentStatusMeta } from '@/lib/status'
import { cn, formatCurrency, timeAgo } from '@/lib/utils'
import type { ActivityLevel } from '@/types'

const levelTone: Record<ActivityLevel, 'blue' | 'green' | 'amber' | 'red' | 'slate'> = {
  info: 'slate',
  success: 'green',
  warning: 'amber',
  'action-required': 'blue',
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Cpu
  label: string
  value: string
  hint?: string
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div className="mt-3 font-display text-2xl font-semibold">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}

export function Overview() {
  const runtime = useAsync(getRuntimeStatus)
  const agents = useAsync(getAgents)
  const activity = useAsync(getActivity)
  const sources = useAsync(getSources)
  const finance = useAsync(getFinance)

  const activeAgents = agents.data?.filter((a) => a.status === 'running').length ?? 0
  const pending = activity.data?.filter((a) => a.pending).length ?? 0
  const runsToday = agents.data?.reduce((n, a) => n + a.runsToday, 0) ?? 0

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Mission Control"
        subtitle="Everything Carlitos is doing right now — on your machine, by default."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={Cpu}
          label="Runtime"
          value={runtime.data ? runtime.data.model : '—'}
          hint={runtime.data ? `${runtime.data.engine} · uptime ${runtime.data.uptime}` : undefined}
        />
        <Stat
          icon={Bot}
          label="Active agents"
          value={String(activeAgents)}
          hint={`${runsToday} runs today across ${agents.data?.length ?? 0} agents`}
        />
        <Stat
          icon={Activity}
          label="Pending approvals"
          value={String(pending)}
          hint="Waiting on your approve / dismiss"
        />
        <Stat
          icon={TrendingUp}
          label="Net worth"
          value={finance.data ? formatCurrency(finance.data.netWorth) : '—'}
          hint={finance.data ? `▲ ${finance.data.netWorthChangePct}% this week · read-only` : undefined}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Activity feed */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Recent activity</CardTitle>
            <Badge variant="muted">{activity.data?.length ?? 0} events</Badge>
          </CardHeader>
          <CardContent className="space-y-1">
            {activity.loading &&
              Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            {activity.data?.slice(0, 5).map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent/50"
              >
                <div className="mt-1">
                  <StatusDot tone={levelTone[item.level]} pulse={item.level === 'action-required'} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    {item.pending && (
                      <Badge variant="default" className="shrink-0">
                        Needs you
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.detail}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {item.source && <SourceIcon id={item.source} className="h-3.5 w-3.5" />}
                  <span className="font-mono">{timeAgo(item.timestamp)}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Right rail */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Agents</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {agents.data?.slice(0, 5).map((a) => {
                const meta = agentStatusMeta[a.status]
                return (
                  <div key={a.id} className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <StatusDot tone={meta.tone} pulse={meta.pulse} />
                      <span className="truncate text-sm">{a.displayName}</span>
                    </div>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {meta.label}
                    </span>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sources</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {sources.data?.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <SourceIcon id={s.id} className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate text-sm">{s.name}</span>
                  </div>
                  <StatusDot
                    tone={s.state === 'connected' ? 'green' : s.state === 'error' ? 'red' : 'blue'}
                    pulse={s.state === 'syncing'}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="flex items-start gap-3 p-5">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div className="text-sm">
                <p className="font-medium">Local-first &amp; read-only</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {runtime.data?.connectorsHealthy ?? 0}/{runtime.data?.connectorsTotal ?? 0}{' '}
                  connectors healthy. No data leaves your device unless you enable a cloud engine.
                </p>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Approval-to-send is on
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <p className={cn('mt-8 text-center text-xs text-muted-foreground')}>
        Carlitos · mission control for your OpenJarvis runtime
      </p>
    </div>
  )
}
