import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ProjectInfo {
  /** Decoded directory path, e.g. "/Users/ll/WebProjects/fleet" */
  dir: string;
  /** Short display name derived from the path */
  name: string;
  /** Number of Claude sessions in this project */
  sessionCount: number;
  /** Last activity timestamp (ms) */
  lastActivity: number;
}

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Decode a project dir name back to a filesystem path, verifying it exists */
function decodeProjectName(encoded: string): string | null {
  const segments = encoded.replace(/^-/, '').split('-');
  if (segments.length === 0) return null;

  // Try greedy: assume all "-" are "/" first
  const directPath = '/' + segments.join('/');
  if (fs.existsSync(directPath)) return directPath;

  // Try merging segments from the right
  return resolvePathByMerge(segments);
}

function resolvePathByMerge(segments: string[]): string | null {
  const queue: Array<{ parts: string[]; merges: number }> = [{ parts: segments, merges: 0 }];
  const maxMerges = 5;

  while (queue.length > 0) {
    const { parts, merges } = queue.shift()!;
    const candidatePath = '/' + parts.join('/');
    if (fs.existsSync(candidatePath)) return candidatePath;

    if (merges >= maxMerges || parts.length <= 1) continue;

    for (let i = 0; i < parts.length - 1; i++) {
      const merged = parts[i] + '-' + parts[i + 1];
      const newParts = [...parts.slice(0, i), merged, ...parts.slice(i + 2)];
      queue.push({ parts: newParts, merges: merges + 1 });
    }
  }
  return null;
}

/** Encode a filesystem path to a project dir name */
export function encodeProjectName(dir: string): string {
  return '-' + dir.replace(/^\//, '').replace(/\//g, '-');
}

/** Scan ~/.claude/projects/ and return projects sorted by recency */
export function scanProjects(): ProjectInfo[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];

  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'memory') continue;

    const dir = decodeProjectName(entry.name);
    if (!dir) continue;
    const fullPath = path.join(PROJECTS_DIR, entry.name);

    let sessionCount = 0;
    let lastActivity = 0;
    try {
      const files = fs.readdirSync(fullPath);
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          sessionCount++;
          try {
            const stat = fs.statSync(path.join(fullPath, f));
            if (stat.mtimeMs > lastActivity) lastActivity = stat.mtimeMs;
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* skip */
    }

    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > lastActivity) lastActivity = stat.mtimeMs;
    } catch {
      /* skip */
    }

    const name = dir.split('/').pop() || dir;
    projects.push({ dir, name, sessionCount, lastActivity });
  }

  projects.sort((a, b) => b.lastActivity - a.lastActivity);
  return projects;
}

/** Raw message from Claude session JSONL */
interface RawMessage {
  type?: string;
  message?: {
    content?: string | Array<{ type?: string; text?: string; name?: string }>;
  };
}

/** Extract the first user message text from a Claude message JSON */
function extractUserText(msg: RawMessage): string | null {
  if (msg.type !== 'user') return null;
  const content = msg.message?.content;
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block !== null && block.type === 'text') {
        return block.text || null;
      }
    }
  }
  return null;
}

/** Read recent session titles from a project's jsonl files */
export function readProjectSessions(
  projectDir: string,
  limit = 10,
): Array<{ title: string; time: number; sessionId: string }> {
  const encoded = encodeProjectName(projectDir);
  const fullPath = path.join(PROJECTS_DIR, encoded);
  if (!fs.existsSync(fullPath)) return [];

  const sessions: Array<{ title: string; time: number; sessionId: string }> = [];

  try {
    const files = fs
      .readdirSync(fullPath)
      .filter((f) => f.endsWith('.jsonl'))
      .sort((a, b) => {
        const sa = fs.statSync(path.join(fullPath, a)).mtimeMs;
        const sb = fs.statSync(path.join(fullPath, b)).mtimeMs;
        return sb - sa;
      })
      .slice(0, limit);

    for (const f of files) {
      const sessionId = f.replace('.jsonl', '');
      try {
        const content = fs.readFileSync(path.join(fullPath, f), 'utf-8');
        const lines = content.split('\n');
        const mtime = fs.statSync(path.join(fullPath, f)).mtimeMs;

        let title = '';
        for (let i = 0; i < Math.min(lines.length, 10); i++) {
          try {
            const parsed = JSON.parse(lines[i]) as RawMessage;
            const text = extractUserText(parsed);
            if (text) {
              title = text;
              break;
            }
          } catch {
            continue;
          }
        }
        sessions.push({
          title: title?.slice(0, 100) || '(no user prompt)',
          time: mtime,
          sessionId,
        });
      } catch {
        sessions.push({ title: '(unreadable)', time: 0, sessionId });
      }
    }
  } catch {
    /* skip */
  }

  return sessions;
}

/** Session file data shape */
interface SessionData {
  pid?: number;
  sessionId?: string;
}

/** Get set of claude session IDs that are currently running */
export function getActiveClaudeSessions(): Set<string> {
  const active = new Set<string>();
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  if (!fs.existsSync(sessionsDir)) return active;

  try {
    const files = fs.readdirSync(sessionsDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(sessionsDir, f), 'utf-8');
        const data = JSON.parse(raw) as SessionData;
        // Check if the PID is still alive (Unix-only; skip on Windows)
        const pid = data.pid;
        if (pid && process.platform !== 'win32') {
          try {
            process.kill(pid, 0);
          } catch {
            continue; // PID not alive
          }
        }
        if (data.sessionId) active.add(data.sessionId);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return active;
}

/** A single message summary from tailSession */
export interface SessionMessage {
  role: string;
  summary: string;
}

/** Read the last N messages from a session JSONL file */
export function tailSession(
  projectDir: string,
  sessionId: string,
  count: number = 8,
): SessionMessage[] {
  const encoded = encodeProjectName(projectDir);
  const jsonlPath = path.join(PROJECTS_DIR, encoded, `${sessionId}.jsonl`);
  if (!fs.existsSync(jsonlPath)) return [];

  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.trim().split('\n');
  // Scan from the end, collect up to 'count' displayable messages
  const messages: SessionMessage[] = [];
  for (let i = lines.length - 1; i >= 0 && messages.length < count; i--) {
    try {
      const msg = JSON.parse(lines[i]) as RawMessage & { type?: string; is_error?: boolean; errors?: string[]; total_cost_usd?: number; duration_ms?: number };
      if (msg.type === 'queue-operation') continue;

      let role = '';
      let summary = '';

      if (msg.type === 'user') {
        const text = extractUserText(msg);
        if (!text) continue;
        role = 'user';
        summary = text;
      } else if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          const parts: string[] = [];
          for (const block of content) {
            if (typeof block === 'object' && block !== null) {
              if (block.type === 'text' && block.text) parts.push(block.text);
              else if (block.type === 'tool_use' && block.name) parts.push(`[${block.name}]`);
            }
          }
          summary = parts.join(' ');
        }
        if (!summary) continue;
        role = 'assistant';
      } else if (msg.type === 'result') {
        role = 'result';
        summary = msg.is_error
          ? `Error: ${msg.errors?.[0] || 'unknown'}`
          : `Done · $${(msg.total_cost_usd || 0).toFixed(3)} · ${((msg.duration_ms || 0) / 1000).toFixed(0)}s`;
      } else {
        continue;
      }

      messages.unshift({ role, summary: summary.slice(0, 300) });
    } catch {
      continue;
    }
  }

  return messages;
}
