# Fleet

A Feishu bot that turns your phone into a Claude Code remote client. Threads are sessions, folders are projects — same workflow as VSCode, but from anywhere.

## Concept

```
Feishu DM (your phone/PC)
  ├── "/dash"       → 🏠 Dashboard (buttons for everything)
  ├── "/projects"   → 📂 Browse Claude projects, tap to switch
  ├── "/list"       → 📋 All sessions: Resume old, Fork running ones
  ├── Send message  → New Claude session (reply to card to continue)
  ├── Reply in thread → Continue that session
  └── Multiple threads → Multiple concurrent Claude sessions
```

**No database. Zero persistence.** Fleet uses Claude Code's native storage (`~/.claude/projects/`, `~/.claude/sessions/`). All fleet state is in-memory — restart and it rebuilds automatically.

## Setup

### 1. Prerequisites

- Node.js 20+
- Claude Code installed and authenticated: `npm install -g @anthropic-ai/claude-code && claude login`
- A Feishu app with bot capability

### 2. Create Feishu App

1. Go to [Feishu Developer Console](https://open.feishu.cn/app) → Create Custom App
2. Add **Bot** capability
3. Go to **Permissions & Scopes** → add these permissions:
   - `im:message` — Read and send messages
   - `im:message:readonly` — Read messages
   - `im:resource` — Upload images and files
4. Go to **Events & Subscriptions**:
   - Set mode to **"Persistent connection"** (WebSocket)
   - Subscribe to events: `im.message.receive_v1`, `card.action.trigger`
5. **Create a version and publish it**

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
npm run dev
```

### 5. Connect

Open Feishu, search for your bot, start a DM.

## Usage

### Main Chat (Dashboard)

| Command | What it does |
|---------|-------------|
| `/<br/>/dash` | Dashboard with quick-action buttons |
| `/projects` | Browse all Claude project folders, tap to switch |
| `/list` | Show sessions in current folder |
| `/folder <name>` | Switch to a named project |
| `/cd <path>` | Set working directory directly |
| `/help` | Show help |

### Conversations (Threads)

- **Start new**: Send any message → bot replies with a streaming card
- **Continue**: Reply to the card (in thread) → bot continues the session
- **Multiple**: Start multiple threads — each is an independent Claude session

### Session Management

In `/list`, each session has:

| Button | What it does |
|--------|-------------|
| ▶ Resume | Create a new thread resuming that Claude session's history |
| ⑂ Fork | Create a native Claude fork (new session, shared history up to fork point) |
| ✕ Archive | Remove from list |
| 🟢 Running | Session is active in VSCode/terminal — Fork instead |

### Detecting Active Sessions

Fleet checks `~/.claude/sessions/` for running Claude processes. If a session is being used by VSCode or terminal, it shows 🟢 and offers Fork instead of Resume — no accidental conflicts.

## Architecture

```
~2200 lines of TypeScript. 11 source files. Zero database.
```

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Entry point: WebSocket client, graceful shutdown |
| `src/bridge.ts` | Core orchestrator: message routing, session lifecycle, Claude execution |
| `src/event-handler.ts` | Feishu WS event dispatcher |
| `src/executor.ts` | Claude Code Agent SDK wrapper |
| `src/stream.ts` | SDK messages → CardState transformer |
| `src/card.ts` | Feishu interactive card builder |
| `src/sender.ts` | Feishu HTTP API client |
| `src/projects.ts` | Claude project scanner, session reader, active session detection |
| `src/config.ts` | Configuration loader |
| `src/types.ts` | Shared type definitions |
| `src/logger.ts` | Pino logger |

## Config reference

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

## License

MIT
