import { useEffect, useState } from 'react'
import { Calendar, RefreshCw, Sparkles, Volume2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { useAsync } from '@/hooks/useAsync'
import { getDigests } from '@/lib/mock'
import { cn } from '@/lib/utils'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

export function Digest() {
  const { data, loading } = useAsync(getDigests)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (data && data.length > 0 && !selected) setSelected(data[0].id)
  }, [data, selected])

  const current = data?.find((d) => d.id === selected) ?? null

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Digest"
        subtitle="Your morning briefings — email, calendar, tasks and news, on demand."
        actions={
          <Button variant="outline" size="sm">
            <RefreshCw className="h-4 w-4" /> jarvis digest --fresh
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        {/* Archive list */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4" /> Archive
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {loading &&
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            {data?.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelected(d.id)}
                className={cn(
                  'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                  d.id === selected
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {formatDate(d.date)}
              </button>
            ))}
          </CardContent>
        </Card>

        {/* Selected digest */}
        <Card>
          {loading || !current ? (
            <CardContent className="space-y-4 p-6">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          ) : (
            <>
              <CardHeader className="border-b border-border">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-primary" />
                      <CardTitle>{formatDate(current.date)}</CardTitle>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{current.greeting}</p>
                  </div>
                  <Button variant="ghost" size="sm">
                    <Volume2 className="h-4 w-4" /> Play
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-6 p-6">
                {current.sections.map((section) => (
                  <div key={section.heading}>
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="font-display text-sm font-semibold">{section.heading}</h3>
                      <Badge variant="muted">{section.items.length}</Badge>
                    </div>
                    <ul className="space-y-1.5">
                      {section.items.map((item, i) => (
                        <li key={i} className="flex gap-2.5 text-sm text-muted-foreground">
                          <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
