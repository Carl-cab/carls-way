import { Cpu, Menu, Wifi } from 'lucide-react'
import { StatusDot } from '@/components/StatusDot'
import { Badge } from '@/components/ui/badge'
import { NAV, type NavKey } from './Sidebar'
import type { RuntimeStatus } from '@/types'

interface TopBarProps {
  active: NavKey
  onNavigate: (key: NavKey) => void
  runtime: RuntimeStatus | null
}

export function TopBar({ active, onNavigate, runtime }: TopBarProps) {
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur md:px-6">
      {/* Mobile nav (simple select) */}
      <div className="relative md:hidden">
        <Menu className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <select
          value={active}
          onChange={(e) => onNavigate(e.target.value as NavKey)}
          className="h-9 appearance-none rounded-md border border-border bg-secondary/50 pl-8 pr-3 text-sm"
          aria-label="Navigate"
        >
          {NAV.map((n) => (
            <option key={n.key} value={n.key}>
              {n.label}
            </option>
          ))}
        </select>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {runtime && (
          <>
            <Badge variant="secondary" className="hidden sm:inline-flex">
              <Cpu className="h-3 w-3" /> {runtime.model}
            </Badge>
            <Badge variant={runtime.engine === 'local' ? 'success' : 'warning'}>
              <Wifi className="h-3 w-3" /> {runtime.engine}
            </Badge>
            <div className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground">
              <StatusDot
                tone={runtime.connectorsHealthy === runtime.connectorsTotal ? 'green' : 'amber'}
              />
              {runtime.connectorsHealthy}/{runtime.connectorsTotal} connectors
            </div>
          </>
        )}
      </div>
    </header>
  )
}
