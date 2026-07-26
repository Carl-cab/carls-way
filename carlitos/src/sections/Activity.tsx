import { useEffect, useMemo, useState } from 'react'
import { Check, Filter, X } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/StatusDot'
import { SourceIcon } from '@/components/SourceIcon'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { useAsync } from '@/hooks/useAsync'
import { getActivity } from '@/lib/mock'
import { cn, timeAgo } from '@/lib/utils'
import type { ActivityItem, ActivityLevel } from '@/types'

const levelTone: Record<ActivityLevel, 'blue' | 'green' | 'amber' | 'red' | 'slate'> = {
  info: 'slate',
  success: 'green',
  warning: 'amber',
  'action-required': 'blue',
}

type Filter = 'all' | 'pending'

export function Activity() {
  const { data, loading } = useAsync(getActivity)
  const [items, setItems] = useState<ActivityItem[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  // Track which pending items the operator has resolved this session.
  const [resolved, setResolved] = useState<Record<string, 'approved' | 'dismissed'>>({})

  useEffect(() => {
    if (data) setItems(data)
  }, [data])

  const shown = useMemo(
    () => (filter === 'pending' ? items.filter((i) => i.pending && !resolved[i.id]) : items),
    [items, filter, resolved],
  )

  const pendingCount = items.filter((i) => i.pending && !resolved[i.id]).length

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Activity"
        subtitle="Your audit log of everything Carlitos did — with approve / dismiss on pending actions."
        actions={
          <div className="flex items-center gap-1 rounded-md border border-border p-1">
            {(['all', 'pending'] as const).map((f) => (
              <Button
                key={f}
                variant={filter === f ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setFilter(f)}
                className="capitalize"
              >
                {f === 'pending' && <Filter className="h-3.5 w-3.5" />}
                {f}
                {f === 'pending' && pendingCount > 0 && (
                  <Badge variant="default" className="ml-1">
                    {pendingCount}
                  </Badge>
                )}
              </Button>
            ))}
          </div>
        }
      />

      <Card>
        <CardContent className="divide-y divide-border p-0">
          {loading &&
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="p-4">
                <Skeleton className="h-12 w-full" />
              </div>
            ))}

          {!loading && shown.length === 0 && (
            <div className="p-10 text-center text-sm text-muted-foreground">
              Nothing here — you're all caught up.
            </div>
          )}

          {shown.map((item) => {
            const state = resolved[item.id]
            return (
              <div key={item.id} className="flex items-start gap-3.5 p-4">
                <div className="mt-1.5">
                  <StatusDot
                    tone={levelTone[item.level]}
                    pulse={item.level === 'action-required' && !state}
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{item.title}</p>
                    <code className="font-mono text-[11px] text-muted-foreground">{item.agent}</code>
                    {item.source && <SourceIcon id={item.source} className="h-3.5 w-3.5 text-muted-foreground" />}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>

                  {item.pending && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {state ? (
                        <Badge variant={state === 'approved' ? 'success' : 'muted'}>
                          {state === 'approved' ? (
                            <>
                              <Check className="h-3 w-3" /> {item.pending.approveLabel}
                            </>
                          ) : (
                            <>
                              <X className="h-3 w-3" /> Dismissed
                            </>
                          )}
                        </Badge>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            onClick={() =>
                              setResolved((r) => ({ ...r, [item.id]: 'approved' }))
                            }
                          >
                            <Check className="h-3.5 w-3.5" /> {item.pending.approveLabel}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setResolved((r) => ({ ...r, [item.id]: 'dismissed' }))
                            }
                          >
                            <X className="h-3.5 w-3.5" /> Dismiss
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <span
                  className={cn(
                    'shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground',
                  )}
                >
                  {timeAgo(item.timestamp)}
                </span>
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
