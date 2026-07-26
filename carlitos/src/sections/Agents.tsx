import { Clock, Play, Terminal } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/StatusDot'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { useAsync } from '@/hooks/useAsync'
import { getAgents } from '@/lib/mock'
import { agentStatusMeta } from '@/lib/status'
import { timeAgo } from '@/lib/utils'
import type { AgentKind } from '@/types'

const kindLabel: Record<AgentKind, string> = {
  scheduled: 'Scheduled',
  'on-demand': 'On-demand',
  continuous: 'Continuous',
  research: 'Research',
  orchestrator: 'Orchestrator',
  coding: 'Coding',
}

export function Agents() {
  const { data, loading } = useAsync(getAgents)

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Agents"
        subtitle="The 8 built-in agents, mapped 1:1 to your OpenJarvis presets."
        actions={
          <Button variant="outline" size="sm">
            <Terminal className="h-4 w-4" /> jarvis init --preset
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading &&
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-52 w-full" />)}

        {data?.map((agent) => {
          const meta = agentStatusMeta[agent.status]
          return (
            <Card key={agent.id} className="flex flex-col">
              <CardHeader className="space-y-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <StatusDot tone={meta.tone} pulse={meta.pulse} />
                    <CardTitle>{agent.displayName}</CardTitle>
                  </div>
                  <Badge variant="muted">{kindLabel[agent.kind]}</Badge>
                </div>
                <code className="mt-2 block font-mono text-xs text-muted-foreground">
                  {agent.name}
                </code>
              </CardHeader>

              <CardContent className="flex flex-1 flex-col">
                <p className="text-sm text-muted-foreground">{agent.description}</p>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  {agent.skills.length === 0 ? (
                    <span className="text-xs text-muted-foreground/70">No skills attached</span>
                  ) : (
                    agent.skills.map((s) => (
                      <Badge key={s} variant="secondary" className="font-mono text-[11px]">
                        {s}
                      </Badge>
                    ))
                  )}
                </div>

                <div className="mt-auto space-y-2 pt-4 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5" /> Last run
                    </span>
                    <span className="font-mono">
                      {agent.lastRun ? timeAgo(agent.lastRun) : 'never'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Next run</span>
                    <span className="font-mono">
                      {agent.nextRun ? `in ${timeAgo(agent.nextRun).replace(' ago', '')}` : 'on-demand'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Runs today</span>
                    <span className="font-mono">{agent.runsToday}</span>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
                  <Badge variant="outline" className="font-mono text-[11px]">
                    {agent.preset}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={agent.status === 'running'}
                  >
                    <Play className="h-3.5 w-3.5" />
                    {agent.status === 'running' ? 'Running' : 'Run'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
