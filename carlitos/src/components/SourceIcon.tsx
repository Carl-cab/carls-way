import { Calendar, CheckSquare, Github, Landmark, Mail, MessageSquare } from 'lucide-react'
import type { SourceId } from '@/types'

const map = {
  gmail: Mail,
  gcal: Calendar,
  gtasks: CheckSquare,
  slack: MessageSquare,
  github: Github,
  plaid: Landmark,
} as const

export function SourceIcon({ id, className }: { id: SourceId; className?: string }) {
  const Icon = map[id]
  return <Icon className={className} />
}
