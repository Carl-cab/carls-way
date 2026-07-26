import {
  Activity as ActivityIcon,
  Bot,
  LayoutDashboard,
  Plug,
  Sparkles,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type NavKey = 'overview' | 'agents' | 'sources' | 'activity' | 'finance' | 'digest'

export const NAV: { key: NavKey; label: string; icon: LucideIcon }[] = [
  { key: 'overview', label: 'Mission Control', icon: LayoutDashboard },
  { key: 'agents', label: 'Agents', icon: Bot },
  { key: 'sources', label: 'Sources', icon: Plug },
  { key: 'activity', label: 'Activity', icon: ActivityIcon },
  { key: 'finance', label: 'Finance', icon: Wallet },
  { key: 'digest', label: 'Digest', icon: Sparkles },
]

interface SidebarProps {
  active: NavKey
  onNavigate: (key: NavKey) => void
  pendingCount: number
}

export function Sidebar({ active, onNavigate, pendingCount }: SidebarProps) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card/40 p-4 md:flex">
      <div className="flex items-center gap-2.5 px-2 py-2">
        <img src="/logo.svg" alt="Carlitos" className="h-8 w-8" />
        <div>
          <p className="font-display text-base font-bold leading-none">Carlitos</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Personal AI</p>
        </div>
      </div>

      <nav className="mt-6 flex flex-1 flex-col gap-1">
        {NAV.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => onNavigate(key)}
            className={cn(
              'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active === key
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
            {key === 'activity' && pendingCount > 0 && (
              <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="rounded-md border border-border bg-secondary/30 p-3 text-[11px] text-muted-foreground">
        <p className="font-medium text-foreground">Local-first</p>
        <p className="mt-1 leading-relaxed">
          Runs on your machine. The cloud is called only when you allow it.
        </p>
      </div>
    </aside>
  )
}
