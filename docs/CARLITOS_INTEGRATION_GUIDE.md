# Carlitos — Integration Guide

**Connecting your personal agent to real data sources**

This guide explains how to take the Carlitos dashboard and make it a live personal agent with access to your platforms (email, calendar, tasks, chat, code, and finances), using [OpenJarvis](https://open-jarvis.github.io/OpenJarvis/) — the local-first personal AI framework it is modeled on — as the runtime underneath.

> **Architecture in one sentence:** OpenJarvis runs locally on your machine as the agent brain (models via Ollama, tools via connectors); Carlitos is the mission-control UI on top. Everything runs on your device by default — the cloud is called only when you allow it.

---

## Step 0 — Install the OpenJarvis runtime

```bash
# macOS / Linux / WSL2 — one-liner (installs uv, Python venv, Ollama, starter model)
curl -fsSL https://open-jarvis.github.io/OpenJarvis/install.sh | bash

# Native Windows
irm https://open-jarvis.github.io/OpenJarvis/install.ps1 | iex
```

Then verify:

```bash
jarvis doctor     # shows runtime status (model, Rust extension, connectors)
jarvis            # start chatting — default preset: chat-simple
```

Rename the persona so the CLI matches your dashboard: in your config (`~/.jarvis/config.yaml` after `jarvis init`), set the agent display name to **Carlitos**.

---

## Step 1 — Connect Google (Gmail + Calendar + Tasks) — one OAuth

```bash
jarvis connect gdrive
```

A browser window opens for Google OAuth. One consent covers Gmail, Google Calendar and Google Tasks — these are the three sources shown as cards on the Carlitos **Sources** page.

**Tips:**

- Grant read scopes first (`mail.read`, calendar read, tasks read). Only enable `mail.send` when you want Carlitos to send drafted replies — keep the dashboard's approval-to-send flow on so nothing goes out without you clicking **Send**.
- After connecting, run `jarvis digest --fresh` to generate your first morning briefing.

---

## Step 2 — Connect Slack

1. Create a Slack app at <https://api.slack.com/apps> → **"From scratch"**.
2. Add a user token with read scopes: `channels:history`, `channels:read`, `groups:read`, `im:read`, `users:read`, `search:read`.
3. Install the app to each workspace (Carlitos supports multiple workspaces).
4. Export the token so OpenJarvis can use it:

```bash
export SLACK_USER_TOKEN="xoxp-..."
jarvis connect slack
```

---

## Step 3 — Connect GitHub

```bash
# easiest: GitHub CLI
gh auth login
jarvis connect github          # reads your gh credentials
```

Or create a fine-grained personal access token (<https://github.com/settings/tokens>) with **repo read** + **pull requests read/write** on the repos you want Carlitos to watch:

```bash
export GITHUB_TOKEN="github_pat_..."
jarvis connect github
```

---

## Step 4 — Connect your finances (Plaid)

This is what powers the **Finance** page (net worth, accounts, transactions, budgets, alerts). The recommended path is **Plaid** — read-only aggregation across banks, cards, brokerages and crypto exchanges.

1. Create a Plaid developer account → <https://dashboard.plaid.com/signup> (free Sandbox + limited Development tier).
2. Get your keys: **Dashboard → Keys → `client_id` + `secret`** (development environment).
3. Configure the connector:

```bash
export PLAID_CLIENT_ID="..."
export PLAID_SECRET="..."
export PLAID_ENV="development"      # sandbox → development → production
jarvis connect plaid
```

4. Link each institution through Plaid Link (the OAuth stepper mocked on the Carlitos Sources page): Chase, Amex, Ally, Fidelity, Robinhood, Coinbase, etc. Each link produces an `access_token` stored locally and encrypted at `~/.jarvis/credentials/` — never in the dashboard.
5. **Keep it read-only:** Plaid's `transactions` + `balances` + `investments` products only. Do **not** enable payment/transfer products — Carlitos should advise, never move money.

**No-Plaid alternatives:**

- **SimpleFIN** (cheap, read-only, US/CA banks) — good for a privacy-first setup.
- **Lunch Money** or **Actual Budget** APIs if you already budget there.
- **Market data only** (portfolio tickers, quotes): Yahoo Finance via `yfinance` — no bank credentials needed at all.

---

## Step 5 — Pick the agents that match your life

```bash
jarvis init --preset morning-digest-mac    # spoken daily briefing (email, calendar, news)
jarvis init --preset scheduled-monitor     # stateful watcher with memory
jarvis init --preset deep-research         # multi-hop research with citations
jarvis init --preset code-assistant        # code execution, file I/O, shell
```

The 8 built-in agents you see on the Carlitos **Agents** page map 1:1 to OpenJarvis: `morning_digest` (scheduled), `deep_research`, `orchestrator`, `native_react`, `native_openhands`, `simple` (on-demand), `monitor_operative`, `operative` (continuous).

**Extend them with skills:**

```bash
jarvis skill install hermes:arxiv                 # example: research skill
jarvis skill sync hermes --category research
jarvis optimize skills --policy dspy              # improve skills from your own traces
```

---

## Step 6 — Point the Carlitos dashboard at the live runtime

The delivered dashboard runs with realistic mock data so you can review the UX. To go live:

1. Run the OpenJarvis API/server mode (see the project docs: <https://open-jarvis.github.io/OpenJarvis/> — user guide → deployment).
2. Replace the mock module `src/lib/mock.ts` with fetch/WebSocket calls to the local OpenJarvis endpoints (agent status, activity stream, source sync state, digest archive, finance summaries). Each page consumes that one module, so it is the single seam to swap.
3. Rebuild: `npm run build` and serve the `dist/` folder (or keep `npm run dev` during dev).

Because both halves run on your machine, **no data leaves your device** unless you explicitly enable a cloud engine.

---

## Step 7 — Security checklist (important for an agent with real access)

- ✅ Start with read-only scopes everywhere; add send/write scopes one at a time.
- ✅ Keep approval-to-send enabled for email and messages.
- ✅ Finance = read-only (no payment products, no transfer permissions).
- ✅ Tokens live in `~/.jarvis/credentials/` (encrypted at rest), never in the frontend.
- ✅ Run `jarvis doctor` after each new connector to confirm health.
- ✅ Review the **Activity** page daily at first — it is your audit log of everything Carlitos did, with approve/dismiss controls for pending actions.

---

## Quick reference

| Source | Command | Scopes to start with |
|---|---|---|
| Gmail / Calendar / Tasks | `jarvis connect gdrive` | read only (+send later) |
| Slack | `jarvis connect slack` | user token, read scopes |
| GitHub | `jarvis connect github` | repo + PR read |
| Finance (Plaid) | `jarvis connect plaid` | transactions, balances, investments |
| Runtime check | `jarvis doctor` | — |
| First briefing | `jarvis digest --fresh` | — |
