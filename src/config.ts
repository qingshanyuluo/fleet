import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ClaudeConfig {
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  model: string;
}

export interface AppConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  defaultWorkingDirectory: string;
  claude: ClaudeConfig;
  folders: Record<string, string>;
  log: { level: string };
}

function expandPath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const CONFIG_PATH = path.resolve(process.env.FLEET_CONFIG || 'config.json');

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);

  cached = {
    feishuAppId: parsed.feishuAppId || process.env.FEISHU_APP_ID || '',
    feishuAppSecret: parsed.feishuAppSecret || process.env.FEISHU_APP_SECRET || '',
    defaultWorkingDirectory: expandPath(parsed.defaultWorkingDirectory || '/Users/ll'),
    claude: {
      maxTurns: parsed.claude?.maxTurns ?? (process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : null),
      maxBudgetUsd: parsed.claude?.maxBudgetUsd ?? (process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : null),
      model: parsed.claude?.model || process.env.CLAUDE_MODEL || 'claude-opus-4-7',
    },
    folders: parsed.folders || {},
    log: {
      level: parsed.log?.level || process.env.LOG_LEVEL || 'info',
    },
  };

  if (!cached.feishuAppId || !cached.feishuAppSecret) {
    throw new Error('Missing feishuAppId/feishuAppSecret in config.json. Set them or use FEISHU_APP_ID/FEISHU_APP_SECRET env vars.');
  }

  return cached;
}
