// Shared domain types for the Carlitos dashboard.
// These mirror the shapes the live OpenJarvis runtime returns, so swapping
// src/lib/mock.ts for real fetch/WebSocket calls requires no changes here.

export type AgentKind =
  | 'scheduled'
  | 'on-demand'
  | 'continuous'
  | 'research'
  | 'orchestrator'
  | 'coding'

export type AgentStatus = 'running' | 'idle' | 'scheduled' | 'paused' | 'error'

export interface Agent {
  id: string
  /** OpenJarvis internal name, e.g. "morning_digest". */
  name: string
  displayName: string
  kind: AgentKind
  status: AgentStatus
  description: string
  preset: string
  /** ISO timestamp of the last run, or null if it has never run. */
  lastRun: string | null
  /** ISO timestamp of the next scheduled run, or null for on-demand agents. */
  nextRun: string | null
  runsToday: number
  skills: string[]
}

export type SourceId = 'gmail' | 'gcal' | 'gtasks' | 'slack' | 'github' | 'plaid'

export type SyncState = 'connected' | 'syncing' | 'error' | 'disconnected'

export interface Source {
  id: SourceId
  name: string
  provider: string
  /** OpenJarvis connect command, e.g. "jarvis connect gdrive". */
  connectCommand: string
  scopes: string[]
  writeEnabled: boolean
  state: SyncState
  lastSync: string | null
  /** One-line count summary shown on the card, e.g. "128 unread". */
  summary: string
}

export type ActivityLevel = 'info' | 'success' | 'warning' | 'action-required'

export interface ActivityItem {
  id: string
  agent: string
  source?: SourceId
  title: string
  detail: string
  level: ActivityLevel
  timestamp: string
  /** Present when the item needs the operator to approve or dismiss it. */
  pending?: {
    kind: 'send-email' | 'send-message' | 'run-agent' | 'write'
    /** What clicking Approve would do, in plain language. */
    approveLabel: string
  }
}

export type AccountType = 'checking' | 'savings' | 'credit' | 'brokerage' | 'crypto'

export interface Account {
  id: string
  institution: string
  name: string
  type: AccountType
  /** Signed balance — negative for credit balances owed. */
  balance: number
  currency: string
  mask: string
}

export interface Transaction {
  id: string
  accountId: string
  date: string
  merchant: string
  category: string
  amount: number
  currency: string
}

export interface Budget {
  category: string
  spent: number
  limit: number
}

export interface FinanceAlert {
  id: string
  level: 'info' | 'warning'
  message: string
}

export interface FinanceSummary {
  netWorth: number
  netWorthChangePct: number
  currency: string
  accounts: Account[]
  recentTransactions: Transaction[]
  budgets: Budget[]
  alerts: FinanceAlert[]
}

export interface DigestSection {
  heading: string
  items: string[]
}

export interface Digest {
  id: string
  date: string
  greeting: string
  sections: DigestSection[]
}

export interface RuntimeStatus {
  persona: string
  model: string
  engine: 'local' | 'cloud'
  rustExtension: boolean
  connectorsHealthy: number
  connectorsTotal: number
  uptime: string
}
