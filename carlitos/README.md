# Carlitos — Personal AI Dashboard

Mission control for a local-first personal AI agent. Carlitos is the UI layer; the
agent brain is an [OpenJarvis](https://open-jarvis.github.io/OpenJarvis/) runtime
that runs on your own machine (models via Ollama, tools via connectors). Everything
runs on your device by default — the cloud is called only when you allow it.

> Setup and connector instructions live in
> [`../docs/CARLITOS_INTEGRATION_GUIDE.md`](../docs/CARLITOS_INTEGRATION_GUIDE.md).

## Stack

- **Vite 7** + **React 19** + **TypeScript**
- **Tailwind CSS 3.4** with shadcn (new-york) design tokens
- **lucide-react** icons — no other runtime UI dependencies

## Pages

| Page | What it shows |
|---|---|
| **Mission Control** | Runtime status, active agents, pending approvals, recent activity, net worth |
| **Agents** | The 8 built-in agents, mapped 1:1 to OpenJarvis presets |
| **Sources** | Gmail / Calendar / Tasks (one OAuth), Slack, GitHub, Plaid — sync state & scopes |
| **Activity** | Audit log with approve / dismiss controls on pending actions |
| **Finance** | Read-only Plaid aggregation: net worth, accounts, budgets, transactions |
| **Digest** | Morning-briefing archive |

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
```

Build for production:

```bash
npm run build && npm run preview
```

## Going live (the single seam)

The dashboard ships with realistic mock data so the UX can be reviewed offline.
Every page consumes data through **one module — `src/lib/mock.ts`**. To connect the
live runtime, replace the bodies of the exported functions there with `fetch` /
WebSocket calls to your local OpenJarvis endpoints. The return types
(`src/types/index.ts`) stay the same, so no other file changes.

```ts
// src/lib/mock.ts — before
export const getAgents = (): Promise<Agent[]> => delay(AGENTS)

// after (live)
export const getAgents = async (): Promise<Agent[]> => {
  const res = await fetch(`${import.meta.env.VITE_JARVIS_API_URL}/api/agents`)
  return res.json()
}
```

## Security posture

Carlitos is built read-only-first: read scopes by default, approval-to-send for
email and messages, and **no payment/transfer permissions** on finance. Tokens live
in `~/.jarvis/credentials/` (managed by OpenJarvis), never in this frontend.
