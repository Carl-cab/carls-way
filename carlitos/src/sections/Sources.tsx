import { Lock, RefreshCw, ShieldAlert } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/StatusDot'
import { SourceIcon } from '@/components/SourceIcon'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { useAsync } from '@/hooks/useAsync'
import { getSources } from '@/lib/mock'
import { sourceStateMeta } from '@/lib/status'
import { timeAgo } from '@/lib/utils'

export function Sources() {
  const { data, loading } = useAsync(getSources)

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Sources"
        subtitle="One OAuth per provider. Read scopes first — add write scopes one at a time."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading &&
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-48 w-full" />)}

        {data?.map((source) => {
          const meta = sourceStateMeta[source.state]
          const needsAttention = source.state === 'error'
          return (
            <Card key={source.id} className={needsAttention ? 'border-destructive/40' : undefined}>
              <CardHeader className="space-y-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <div className="grid h-9 w-9 place-items-center rounded-md bg-secondary">
                      <SourceIcon id={source.id} className="h-4.5 w-4.5 text-foreground" />
                    </div>
                    <div>
                      <CardTitle>{source.name}</CardTitle>
                      <p className="mt-0.5 text-xs text-muted-foreground">{source.provider}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StatusDot tone={meta.tone} pulse={meta.pulse} />
                    <span className="text-xs text-muted-foreground">{meta.label}</span>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                <p className="text-sm">{source.summary}</p>

                <code className="block truncate rounded-md bg-secondary/60 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
                  $ {source.connectCommand}
                </code>

                <div className="flex flex-wrap gap-1.5">
                  {source.scopes.map((scope) => (
                    <Badge key={scope} variant="secondary" className="font-mono text-[11px]">
                      {scope}
                    </Badge>
                  ))}
                </div>

                <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    {source.writeEnabled ? (
                      <>
                        <ShieldAlert className="h-3.5 w-3.5 text-warning" /> write enabled
                      </>
                    ) : (
                      <>
                        <Lock className="h-3.5 w-3.5 text-success" /> read-only
                      </>
                    )}
                  </span>
                  <span className="font-mono">
                    {source.lastSync ? `synced ${timeAgo(source.lastSync)}` : 'never synced'}
                  </span>
                </div>

                {needsAttention && (
                  <Button variant="outline" size="sm" className="w-full">
                    <RefreshCw className="h-3.5 w-3.5" /> Re-authenticate
                  </Button>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
