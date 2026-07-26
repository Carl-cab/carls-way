import { cn } from '@/lib/utils'

type Tone = 'green' | 'amber' | 'red' | 'blue' | 'slate'

const toneMap: Record<Tone, string> = {
  green: 'bg-success',
  amber: 'bg-warning',
  red: 'bg-destructive',
  blue: 'bg-primary',
  slate: 'bg-muted-foreground',
}

/** A small status indicator; `pulse` adds an expanding ring for live states. */
export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5">
      {pulse && (
        <span
          className={cn('absolute inline-flex h-full w-full rounded-full opacity-60', toneMap[tone], 'animate-pulse-ring')}
        />
      )}
      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', toneMap[tone])} />
    </span>
  )
}
