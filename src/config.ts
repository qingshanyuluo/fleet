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
  healthPort: number;
}

function expandPath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const CONFIG_PATH = path.resolve(process.env.FLEET_CONFIG || 'config.json');

let cached: AppConfig | undefined;

/** Safely parse a JSON value to a number or return null */
function parseOptionalInt(val: unknown): number | null {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = parseInt(val, 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

function parseOptionalFloat(val: unknown): number | null {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  }
  return null;
}

export function loadConfig(): AppConfig {
  if (cached) return cached;

  let parsed: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    parsed = JSON.parse(raw);
  }

  const claudeRaw = (parsed.claude as Record<string, unknown>) || {};
  const logRaw = (parsed.log as Record<string, unknown>) || {};

  cached = {
    feishuAppId: (parsed.feishuAppId as string) || process.env.FEISHU_APP_ID || '',
    feishuAppSecret: (parsed.feishuAppSecret as string) || process.env.FEISHU_APP_SECRET || '',
    defaultWorkingDirectory: expandPath((parsed.defaultWorkingDirectory as string) || os.homedir()),
    claude: {
      maxTurns:
        parseOptionalInt(claudeRaw.maxTurns) ??
        parseOptionalInt(process.env.CLAUDE_MAX_TURNS),
      maxBudgetUsd:
        parseOptionalFloat(claudeRaw.maxBudgetUsd) ??
        parseOptionalFloat(process.env.CLAUDE_MAX_BUDGET_USD),
      model:
        (claudeRaw.model as string) || process.env.CLAUDE_MODEL || 'claude-opus-4-7',
    },
    folders: (parsed.folders as Record<string, string>) || {},
    log: {
      level: (logRaw.level as string) || process.env.LOG_LEVEL || 'info',
    },
    healthPort: parseInt(process.env.HEALTH_PORT || '9100', 10),
  };

  if (!cached.feishuAppId || !cached.feishuAppSecret) {
    throw new Error(
      'Missing feishuAppId/feishuAppSecret. Set them in config.json or via FEISHU_APP_ID/FEISHU_APP_SECRET env vars.',
    );
  }

  return cached;
}
