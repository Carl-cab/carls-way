// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE DATA SEAM
//
// Every page consumes Carlitos data through this one module. The dashboard ships
// with realistic mock data so the UX can be reviewed offline. To go live, replace
// the bodies of the exported functions below with fetch/WebSocket calls to your
// local OpenJarvis endpoints (agent status, activity stream, source sync state,
// digest archive, finance summaries). The return types must not change — the rest
// of the app depends only on the shapes in src/types, not on where they come from.
//
//   Example (live):
//     export async function getAgents(): Promise<Agent[]> {
//       const res = await fetch('http://127.0.0.1:8787/api/agents')
//       return res.json()
//     }
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Agent,
  ActivityItem,
  Digest,
  FinanceSummary,
  RuntimeStatus,
  Source,
} from '@/types'

/** Simulate network latency so loading states are exercised in dev. */
function delay<T>(value: T, ms = 320): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/** Minutes/hours-ago helper for building believable timestamps. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}
function ahead(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

// ── Runtime ──────────────────────────────────────────────────────────────────

const RUNTIME: RuntimeStatus = {
  persona: 'Carlitos',
  model: 'llama3.1:8b-instruct',
  engine: 'local',
  rustExtension: true,
  connectorsHealthy: 5,
  connectorsTotal: 6,
  uptime: '4d 6h',
}

// ── Agents (the 8 built-ins that map 1:1 to OpenJarvis) ───────────────────────

const AGENTS: Agent[] = [
  {
    id: 'morning_digest',
    name: 'morning_digest',
    displayName: 'Morning Digest',
    kind: 'scheduled',
    status: 'scheduled',
    description: 'Spoken daily briefing from email, calendar, tasks and news.',
    preset: 'morning-digest-mac',
    lastRun: ago(60 * 8),
    nextRun: ahead(60 * 15),
    runsToday: 1,
    skills: ['gmail:summarize', 'calendar:agenda', 'news:headlines'],
  },
  {
    id: 'deep_research',
    name: 'deep_research',
    displayName: 'Deep Research',
    kind: 'research',
    status: 'running',
    description: 'Multi-hop research with citations across the open web and your files.',
    preset: 'deep-research',
    lastRun: ago(12),
    nextRun: null,
    runsToday: 3,
    skills: ['hermes:arxiv', 'web:search', 'files:grep'],
  },
  {
    id: 'orchestrator',
    name: 'orchestrator',
    displayName: 'Orchestrator',
    kind: 'orchestrator',
    status: 'idle',
    description: 'Plans and delegates multi-agent workflows to the right operative.',
    preset: 'orchestrator',
    lastRun: ago(90),
    nextRun: null,
    runsToday: 5,
    skills: ['planning:decompose', 'agents:route'],
  },
  {
    id: 'native_react',
    name: 'native_react',
    displayName: 'ReAct',
    kind: 'on-demand',
    status: 'idle',
    description: 'Reason-and-act loop for tool-heavy tasks with tight feedback.',
    preset: 'code-assistant',
    lastRun: ago(200),
    nextRun: null,
    runsToday: 2,
    skills: ['shell:exec', 'files:io'],
  },
  {
    id: 'native_openhands',
    name: 'native_openhands',
    displayName: 'OpenHands',
    kind: 'coding',
    status: 'idle',
    description: 'Autonomous coding agent for repo edits, tests and pull requests.',
    preset: 'code-assistant',
    lastRun: ago(340),
    nextRun: null,
    runsToday: 1,
    skills: ['git:commit', 'github:pr', 'shell:exec'],
  },
  {
    id: 'simple',
    name: 'simple',
    displayName: 'Simple',
    kind: 'on-demand',
    status: 'idle',
    description: 'Fast on-demand chat — the default preset for quick questions.',
    preset: 'chat-simple',
    lastRun: ago(4),
    nextRun: null,
    runsToday: 27,
    skills: [],
  },
  {
    id: 'monitor_operative',
    name: 'monitor_operative',
    displayName: 'Monitor',
    kind: 'scheduled',
    status: 'running',
    description: 'Stateful watcher with memory — flags changes across your sources.',
    preset: 'scheduled-monitor',
    lastRun: ago(6),
    nextRun: ahead(24),
    runsToday: 40,
    skills: ['github:watch', 'slack:mentions', 'memory:recall'],
  },
  {
    id: 'operative',
    name: 'operative',
    displayName: 'Operative',
    kind: 'continuous',
    status: 'paused',
    description: 'Continuous background worker for long-running objectives.',
    preset: 'scheduled-monitor',
    lastRun: ago(30),
    nextRun: null,
    runsToday: 12,
    skills: ['memory:recall', 'web:search'],
  },
]

// ── Sources (Gmail/Calendar/Tasks via one OAuth, Slack, GitHub, Plaid) ────────

const SOURCES: Source[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    provider: 'Google',
    connectCommand: 'jarvis connect gdrive',
    scopes: ['mail.read'],
    writeEnabled: false,
    state: 'connected',
    lastSync: ago(3),
    summary: '128 unread · 6 need a reply',
  },
  {
    id: 'gcal',
    name: 'Google Calendar',
    provider: 'Google',
    connectCommand: 'jarvis connect gdrive',
    scopes: ['calendar.read'],
    writeEnabled: false,
    state: 'connected',
    lastSync: ago(3),
    summary: '4 events today · next in 2h',
  },
  {
    id: 'gtasks',
    name: 'Google Tasks',
    provider: 'Google',
    connectCommand: 'jarvis connect gdrive',
    scopes: ['tasks.read'],
    writeEnabled: false,
    state: 'connected',
    lastSync: ago(3),
    summary: '9 open · 2 overdue',
  },
  {
    id: 'slack',
    name: 'Slack',
    provider: 'Slack',
    connectCommand: 'jarvis connect slack',
    scopes: ['channels:history', 'channels:read', 'users:read', 'search:read'],
    writeEnabled: false,
    state: 'syncing',
    lastSync: ago(1),
    summary: '2 workspaces · 3 mentions',
  },
  {
    id: 'github',
    name: 'GitHub',
    provider: 'GitHub',
    connectCommand: 'jarvis connect github',
    scopes: ['repo:read', 'pull_requests:read'],
    writeEnabled: true,
    state: 'connected',
    lastSync: ago(9),
    summary: '5 repos watched · 2 PRs to review',
  },
  {
    id: 'plaid',
    name: 'Finance',
    provider: 'Plaid',
    connectCommand: 'jarvis connect plaid',
    scopes: ['transactions', 'balances', 'investments'],
    writeEnabled: false,
    state: 'error',
    lastSync: ago(60 * 26),
    summary: 'Chase re-auth required',
  },
]

// ── Activity (audit log + pending approvals) ──────────────────────────────────

const ACTIVITY: ActivityItem[] = [
  {
    id: 'a1',
    agent: 'morning_digest',
    source: 'gmail',
    title: 'Drafted reply to Priya Nair',
    detail: 'Re: "Q3 planning sync" — confirms Thursday 2pm and asks for the deck.',
    level: 'action-required',
    timestamp: ago(8),
    pending: { kind: 'send-email', approveLabel: 'Send draft reply' },
  },
  {
    id: 'a2',
    agent: 'monitor_operative',
    source: 'github',
    title: 'New review request on carls-way#142',
    detail: '"docs: Carlitos integration guide" is waiting on your review.',
    level: 'action-required',
    timestamp: ago(14),
    pending: { kind: 'run-agent', approveLabel: 'Have OpenHands summarize the diff' },
  },
  {
    id: 'a3',
    agent: 'deep_research',
    title: 'Finished research: local LLM eval harnesses',
    detail: 'Compiled 11 sources with citations. Saved to ~/.jarvis/research/2026-07-26.md.',
    level: 'success',
    timestamp: ago(12),
  },
  {
    id: 'a4',
    agent: 'monitor_operative',
    source: 'slack',
    title: '3 mentions across 2 workspaces',
    detail: '#eng-oncall (2) and #design-review (1). None flagged urgent.',
    level: 'info',
    timestamp: ago(22),
  },
  {
    id: 'a5',
    agent: 'monitor_operative',
    source: 'plaid',
    title: 'Chase connection needs re-authentication',
    detail: 'Plaid token expired 26h ago. Finance totals may be stale until re-linked.',
    level: 'warning',
    timestamp: ago(60 * 26),
  },
  {
    id: 'a6',
    agent: 'morning_digest',
    title: 'Delivered morning briefing',
    detail: 'Spoken digest played at 07:30. 12 items across email, calendar and news.',
    level: 'success',
    timestamp: ago(60 * 8),
  },
  {
    id: 'a7',
    agent: 'simple',
    title: 'Answered 4 quick questions',
    detail: 'All handled locally on llama3.1:8b — no cloud calls.',
    level: 'info',
    timestamp: ago(40),
  },
]

// ── Finance (read-only aggregation) ───────────────────────────────────────────

const FINANCE: FinanceSummary = {
  netWorth: 184230,
  netWorthChangePct: 1.8,
  currency: 'USD',
  accounts: [
    { id: 'acc1', institution: 'Chase', name: 'Total Checking', type: 'checking', balance: 8420, currency: 'USD', mask: '4021' },
    { id: 'acc2', institution: 'Ally', name: 'Online Savings', type: 'savings', balance: 32500, currency: 'USD', mask: '8890' },
    { id: 'acc3', institution: 'Amex', name: 'Gold Card', type: 'credit', balance: -1840, currency: 'USD', mask: '1007' },
    { id: 'acc4', institution: 'Fidelity', name: 'Brokerage', type: 'brokerage', balance: 96200, currency: 'USD', mask: '5533' },
    { id: 'acc5', institution: 'Robinhood', name: 'Individual', type: 'brokerage', balance: 24350, currency: 'USD', mask: '2214' },
    { id: 'acc6', institution: 'Coinbase', name: 'Portfolio', type: 'crypto', balance: 24600, currency: 'USD', mask: 'BTC' },
  ],
  recentTransactions: [
    { id: 't1', accountId: 'acc3', date: ago(120), merchant: 'Blue Bottle Coffee', category: 'Dining', amount: -6.75, currency: 'USD' },
    { id: 't2', accountId: 'acc1', date: ago(60 * 20), merchant: 'Payroll — Acme Inc', category: 'Income', amount: 4200, currency: 'USD' },
    { id: 't3', accountId: 'acc3', date: ago(60 * 26), merchant: 'Whole Foods Market', category: 'Groceries', amount: -112.4, currency: 'USD' },
    { id: 't4', accountId: 'acc3', date: ago(60 * 30), merchant: 'Uber', category: 'Transport', amount: -18.2, currency: 'USD' },
    { id: 't5', accountId: 'acc4', date: ago(60 * 48), merchant: 'Dividend — VTI', category: 'Investment', amount: 86.11, currency: 'USD' },
    { id: 't6', accountId: 'acc3', date: ago(60 * 52), merchant: 'Netflix', category: 'Subscriptions', amount: -15.49, currency: 'USD' },
  ],
  budgets: [
    { category: 'Dining', spent: 320, limit: 400 },
    { category: 'Groceries', spent: 512, limit: 600 },
    { category: 'Transport', spent: 180, limit: 250 },
    { category: 'Subscriptions', spent: 96, limit: 100 },
  ],
  alerts: [
    { id: 'f1', level: 'warning', message: 'Subscriptions budget is at 96% with 5 days left in the cycle.' },
    { id: 'f2', level: 'info', message: 'Fidelity brokerage is up 1.8% this week.' },
  ],
}

// ── Digest archive ────────────────────────────────────────────────────────────

const DIGESTS: Digest[] = [
  {
    id: 'd-2026-07-26',
    date: ago(60 * 8),
    greeting: 'Good morning, Carlos. Here is your Saturday briefing.',
    sections: [
      {
        heading: 'Calendar',
        items: [
          '2:00pm — Q3 planning sync with Priya (needs the deck attached)',
          '4:30pm — 1:1 with Dana',
          'No conflicts; your morning is clear for focus work.',
        ],
      },
      {
        heading: 'Email',
        items: [
          '6 messages need a reply; 1 draft is ready for your approval.',
          'Priya asked to confirm Thursday — draft prepared.',
        ],
      },
      {
        heading: 'Tasks',
        items: ['2 overdue: "Renew domain", "Send invoice #204".'],
      },
      {
        heading: 'News',
        items: ['Local LLM tooling roundup — 3 new eval harnesses worth a look.'],
      },
    ],
  },
  {
    id: 'd-2026-07-25',
    date: ago(60 * 32),
    greeting: 'Good morning, Carlos. Here is your Friday briefing.',
    sections: [
      {
        heading: 'Calendar',
        items: ['10:00am — Design review', '1:00pm — Lunch with Sam'],
      },
      {
        heading: 'Email',
        items: ['4 messages need a reply; nothing urgent overnight.'],
      },
      {
        heading: 'Finance',
        items: ['Payroll deposited $4,200. Net worth up 0.6% on the week.'],
      },
    ],
  },
]

// ── Public API (swap these bodies for live calls) ─────────────────────────────

export const getRuntimeStatus = (): Promise<RuntimeStatus> => delay(RUNTIME)
export const getAgents = (): Promise<Agent[]> => delay(AGENTS)
export const getSources = (): Promise<Source[]> => delay(SOURCES)
export const getActivity = (): Promise<ActivityItem[]> => delay(ACTIVITY)
export const getFinance = (): Promise<FinanceSummary> => delay(FINANCE)
export const getDigests = (): Promise<Digest[]> => delay(DIGESTS)
