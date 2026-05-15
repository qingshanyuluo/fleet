import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { ThreadSession, ChatState, PendingQuestion } from '../types.js';

const STATE_DIR = path.join(os.homedir(), '.fleet');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

interface PersistedState {
  sessions: ThreadSession[];
  chatStates: Record<string, ChatState>;
}

/**
 * Session manager — persisted CRUD for threads, chat state.
 * Thread↔session mappings survive restarts via ~/.fleet/state.json.
 */
export class SessionManager {
  private sessionsByRoot = new Map<string, ThreadSession>();
  private sessionsById = new Map<string, ThreadSession>();
  private chatStates = new Map<string, ChatState>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private config: AppConfig) {
    this.loadFromDisk();
  }

  create(opts: {
    folder: string;
    workingDir: string;
    title: string;
    claudeSessionId?: string;
  }): ThreadSession {
    const session: ThreadSession = {
      id: randomUUID(),
      rootMessageId: '',
      claudeSessionId: opts.claudeSessionId || null,
      workingDirectory: opts.workingDir,
      folder: opts.folder,
      title: opts.title,
      createdAt: Date.now(),
    };
    return session;
  }

  save(session: ThreadSession): void {
    if (session.rootMessageId) {
      this.sessionsByRoot.set(session.rootMessageId, session);
    }
    this.sessionsById.set(session.id, session);
    this.schedulePersist();
  }

  getByRoot(rootId: string): ThreadSession | undefined {
    return this.sessionsByRoot.get(rootId);
  }

  getById(id: string): ThreadSession | undefined {
    return this.sessionsById.get(id);
  }

  delete(session: ThreadSession): void {
    if (session.rootMessageId) {
      this.sessionsByRoot.delete(session.rootMessageId);
    }
    this.sessionsById.delete(session.id);
    this.schedulePersist();
  }

  allSessions(): IterableIterator<ThreadSession> {
    return this.sessionsById.values();
  }

  getChatState(chatId: string): ChatState {
    let state = this.chatStates.get(chatId);
    if (!state) {
      state = {
        currentFolder: 'default',
        currentWorkingDirectory: this.config.defaultWorkingDirectory,
      };
      this.chatStates.set(chatId, state);
    }
    return state;
  }

  setChatState(chatId: string, state: ChatState): void {
    this.chatStates.set(chatId, state);
    this.schedulePersist();
  }

  // ── Persistence ──

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.saveToDisk();
    }, 1000);
  }

  private saveToDisk(): void {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const state: PersistedState = {
        sessions: [...this.sessionsById.values()],
        chatStates: Object.fromEntries(this.chatStates),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {
      /* best-effort */
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(raw) as PersistedState;
      for (const s of state.sessions || []) {
        this.sessionsById.set(s.id, s);
        if (s.rootMessageId) {
          this.sessionsByRoot.set(s.rootMessageId, s);
        }
      }
      for (const [chatId, cs] of Object.entries(state.chatStates || {})) {
        this.chatStates.set(chatId, cs);
      }
    } catch {
      /* ignore corrupt state */
    }
  }
}

export type { ThreadSession, ChatState, PendingQuestion };
