import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { ThreadSession, ChatState, PendingQuestion } from '../types.js';

/**
 * Session manager — in-memory CRUD for threads, chat state, running tasks, and message queues.
 * Extracted from bridge.ts to keep the orchestrator focused on execution flow.
 */
export class SessionManager {
  private sessionsByRoot = new Map<string, ThreadSession>(); // rootMessageId → session
  private sessionsById = new Map<string, ThreadSession>(); // id → session
  private chatStates = new Map<string, ChatState>(); // chatId → current folder/wd

  constructor(private config: AppConfig) {}

  create(opts: {
    folder: string;
    workingDir: string;
    title: string;
    claudeSessionId?: string;
  }): ThreadSession {
    const session: ThreadSession = {
      id: randomUUID(),
      rootMessageId: '', // set after card is sent
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
  }

  allSessions(): IterableIterator<ThreadSession> {
    return this.sessionsById.values();
  }

  // Chat state management

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
  }
}

// Re-export types used by bridge consumers
export type { ThreadSession, ChatState, PendingQuestion };
