import type { AgentStatus, SyncState } from '@/types'

type Tone = 'green' | 'amber' | 'red' | 'blue' | 'slate'

export const agentStatusMeta: Record<AgentStatus, { tone: Tone; label: string; pulse: boolean }> = {
  running: { tone: 'blue', label: 'Running', pulse: true },
  idle: { tone: 'slate', label: 'Idle', pulse: false },
  scheduled: { tone: 'green', label: 'Scheduled', pulse: false },
  paused: { tone: 'amber', label: 'Paused', pulse: false },
  error: { tone: 'red', label: 'Error', pulse: false },
}

export const sourceStateMeta: Record<SyncState, { tone: Tone; label: string; pulse: boolean }> = {
  connected: { tone: 'green', label: 'Connected', pulse: false },
  syncing: { tone: 'blue', label: 'Syncing', pulse: true },
  error: { tone: 'red', label: 'Attention', pulse: false },
  disconnected: { tone: 'slate', label: 'Disconnected', pulse: false },
}
