# Fleet

Turn your phone into a Claude Code terminal. Send a message on Feishu, get a full coding session — threads are sessions, tap to resume, watch from anywhere.

## Why Fleet

You're on the subway and realize you need Claude to fix that bug. Or you're in a meeting and want to check if your refactor finished. Or you just don't want to open your laptop for a quick task.

Fleet bridges Feishu and Claude Code. Every thread is an independent session. Start from your phone, continue on desktop, pick up tomorrow — it's all the same conversation.

## What It Does

**Start a session** — Send any message. Fleet spins up Claude Code in your project directory and streams the response back as an interactive card.

**Continue in thread** — Reply in the thread to keep talking. Same session, full context.

**Watch running sessions** — Claude running in VSCode? Tap 👀 Watch to see what it's doing right now.

**Fork anywhere** — See an interesting session? Fork it. You get the full history in a new branch.

**Search everything** — `/list deploy fix` finds that session from last week where you fixed the deploy script.

**Never lose context** — Session mappings persist to disk. Restart the server, switch devices — your threads still connect to the right sessions.

**Smart stall detection** — If Claude's API hangs (30s) or a tool stalls (3min), Fleet auto-stops and tells you. Reply to pick up where you left off.

**Native tables** — Claude outputs a markdown table? Fleet renders it as a proper Feishu table component, not raw pipe characters.

## Quick Start

```bash
git clone https://github.com/qingshanyuluo/fleet.git
cd fleet
npm install
cp config.example.json config.json
# Fill in your Feishu App ID and Secret
pm2 start ecosystem.config.cjs
```

Prerequisites: Node.js 20+, Claude Code installed (`npm i -g @anthropic-ai/claude-code && claude login`), a Feishu app with Bot capability + WebSocket events.

## Commands

| Command | Action |
|---------|--------|
| `/dash` | Dashboard |
| `/list` | Browse sessions (collapsible, with previews) |
| `/list <keyword>` | Search all sessions |
| `/projects` | Switch project folder |
| `/stop` | Stop current task (in thread) |
| `/reset` | Fresh session (in thread) |

## Feishu App Setup

1. [Developer Console](https://open.feishu.cn/app) → Create Custom App → Add Bot
2. Permissions: `im:message`, `im:message:readonly`, `im:resource`
3. Events: mode = **Persistent connection**, subscribe `im.message.receive_v1` + `card.action.trigger`
4. Publish

## Config

```json
{
  "feishuAppId": "cli_xxx",
  "feishuAppSecret": "...",
  "defaultWorkingDirectory": "~/Code",
  "claude": { "model": "claude-opus-4-7" },
  "folders": {
    "myapp": "/Users/you/Code/myapp",
    "infra": "/Users/you/Code/infra"
  }
}
```

## How It Works

Fleet spawns Claude Code as a subprocess via the Agent SDK, streams output token-by-token into Feishu interactive cards, and maps threads to sessions. State lives in `~/.fleet/state.json`. No database.

## License

MIT
