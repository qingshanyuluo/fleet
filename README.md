# Fleet

A Feishu bot that turns your phone into a Claude Code remote client. Threads are sessions, folders are projects — same workflow as VSCode, but from anywhere.

## Concept

```
Feishu DM (your phone/PC)
  ├── "/dash"         → 🏠 Dashboard with quick-action buttons
  ├── "/projects"     → 📂 Browse Claude projects, tap to switch
  ├── "/list"         → 📋 Collapsible session list with previews
  ├── "/list <query>" → 🔍 Search all sessions by keyword
  ├── Send message    → New Claude session (reply to card to continue)
  ├── Reply in thread → Continue that session
  └── Multiple threads → Multiple concurrent Claude sessions
```

## Features

- **Collapsible session list** — Feishu Card JSON 2.0 native `collapsible_panel`, click to expand previews and action buttons
- **Session search** — `/list <keyword>` searches across all Claude sessions (summary, title, first prompt)
- **Watch running sessions** — See real-time output of sessions running in VSCode/terminal
- **Fork & Resume** — Native Claude fork (shared history) or resume existing sessions
- **AskUserQuestion** — Interactive question cards with option buttons
- **File & Image support** — Send images/files from Feishu, Claude analyzes them
- **Stall detection** — 30s no API response or 3min no tool output → auto-stop, session preserved, reply to continue
- **Auto-retry** — Stale session and context overflow auto-retry with fresh session
- **Persistent state** — Thread↔session mappings survive restarts (`~/.fleet/state.json`)
- **PM2 managed** — Auto-restart on crash, graceful shutdown, log rotation

## Setup

### 1. Prerequisites

- Node.js 20+
- Claude Code installed and authenticated: `npm install -g @anthropic-ai/claude-code && claude login`
- A Feishu app with bot capability

### 2. Create Feishu App

1. Go to [Feishu Developer Console](https://open.feishu.cn/app) → Create Custom App
2. Add **Bot** capability
3. Go to **Permissions & Scopes** → add:
   - `im:message` — Read and send messages
   - `im:message:readonly` — Read messages
   - `im:resource` — Upload images and files
4. Go to **Events & Subscriptions**:
   - Set mode to **"Persistent connection"** (WebSocket)
   - Subscribe to: `im.message.receive_v1`, `card.action.trigger`
5. Create a version and publish

### 3. Install & Configure

```bash
git clone https://github.com/qingshanyuluo/fleet.git
cd fleet
npm install
cp config.example.json config.json
# Edit config.json with your Feishu App ID and App Secret
```

### 4. Run

```bash
# Development
npm run dev

# Production (PM2)
pm2 start ecosystem.config.cjs
pm2 save
```

### 5. Connect

Open Feishu, search for your bot, start a DM.

## Usage

### Commands

| Command | What it does |
|---------|-------------|
| `/dash` | Dashboard with quick-action buttons |
| `/projects` | Browse all Claude project folders, tap to switch |
| `/list` | Collapsible session list (5/page, with previews) |
| `/list <keyword>` | Search all sessions by keyword |
| `/folder <name>` | Switch to a named project |
| `/cd <path>` | Set working directory |
| `/stop` | Stop running task (use in thread) |
| `/reset` | Fresh conversation (use in thread) |
| `/help` | Show help |

### Conversations

- **Start new**: Send any message → bot replies with a streaming card
- **Continue**: Reply in the thread → bot continues the session
- **Multiple**: Start multiple threads — each is an independent Claude session

### Session List (`/list`)

Each session is a collapsible panel. Click to expand and see:
- Last 4 messages preview (user prompts + Claude responses)
- Action buttons: Resume, Fork, Watch, Archive

| Button | What it does |
|--------|-------------|
| ▶ Resume | Continue that Claude session in a new thread |
| ⑂ Fork | Native Claude fork (new session, shared history) |
| 👀 Watch | View recent output of a running session |
| ✕ Archive | Remove from list |

Pagination: 5 sessions per page with Prev/Next buttons.

### Active Session Detection

Fleet checks `~/.claude/sessions/` for running Claude processes. Running sessions show 🟢 and offer Watch + Fork instead of Resume.

## Architecture

```
~3400 lines of TypeScript. 18 source files.
Persistent state: ~/.fleet/state.json
```

| Directory | Responsibility |
|-----------|---------------|
| `src/bridge/` | Core orchestrator, command handler, session manager |
| `src/core/` | Claude SDK executor, stream processor, project scanner |
| `src/feishu/` | Card builder, event handler, Feishu API sender |
| `src/index.ts` | Entry point: WebSocket client, health check, graceful shutdown |
| `src/config.ts` | Configuration loader |
| `src/types.ts` | Shared type definitions |
| `src/logger.ts` | Pino logger |

## Config Reference

```json
{
  "feishuAppId": "cli_xxx",
  "feishuAppSecret": "...",
  "defaultWorkingDirectory": "/Users/you",
  "claude": {
    "maxTurns": null,
    "maxBudgetUsd": null,
    "model": "claude-opus-4-7"
  },
  "folders": {
    "myproject": "/Users/you/Code/myproject",
    "fleet": "/Users/you/Code/fleet"
  }
}
```

## Deployment

### PM2 (Recommended)

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # auto-start on boot
```

### Docker

```bash
docker compose up -d
```

## License

MIT
