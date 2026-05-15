import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { IncomingMessage, ThreadSession } from '../types.js';
import { Sender } from '../feishu/sender.js';
import { buildTextCard, buildDashCard, buildProjectListCard, buildSessionListCard } from '../feishu/card-builder.js';
import { scanProjects, readProjectSessions, getActiveClaudeSessions, tailSession } from '../core/projects.js';
import type { SessionManager } from './session-manager.js';

/**
 * Command handler — processes /slash commands from messages and card actions.
 * Extracted from bridge.ts to keep the orchestrator focused on execution.
 */
export class CommandHandler {
  constructor(
    private config: AppConfig,
    private logger: Logger,
    private sender: Sender,
    private sessions: SessionManager,
  ) {}

  async showSessionsPage(chatId: string, page: number): Promise<void> {
    await this.showSessions(chatId, page);
  }

  async handleMessage(msg: IncomingMessage): Promise<boolean> {
    const { text, chatId } = msg;
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    switch (cmd) {
      case '/help':
        await this.showHelp(chatId);
        return true;
      case '/dash':
      case '/':
        await this.showDash(chatId);
        return true;
      case '/projects':
      case '/project':
        await this.showProjects(chatId);
        return true;
      case '/list':
        if (arg) {
          await this.searchSessions(chatId, arg);
        } else {
          await this.showSessions(chatId);
        }
        return true;
      case '/folder':
        await this.switchFolder(chatId, arg);
        return true;
      case '/cd':
        await this.setDirectory(chatId, arg);
        return true;
      case '/folders':
        await this.listFolders(chatId);
        return true;
      case '/stop':
        await this.sender.sendCard(
          chatId,
          buildTextCard('Stop', 'Use `/stop` inside a thread.', 'yellow'),
        );
        return true;
      case '/reset':
        await this.resetSession(chatId, msg.rootId);
        return true;
    }
    return false;
  }

  private async showHelp(chatId: string): Promise<void> {
    await this.sender.sendCard(
      chatId,
      buildTextCard(
        'Fleet Help',
        [
          '`/dash` — Dashboard',
          '`/projects` — Browse Claude projects',
          '`/folder <name>` — Switch folder',
          '`/cd <path>` — Set working directory',
          '`/list` — Show sessions',
          '`/stop` — Stop current task (in thread)',
          '`/reset` — Fresh conversation (in thread)',
          '`/fork` — Fork session (in thread)',
          '',
          '**How:** Send a message to start a new thread.',
          'Reply in a thread to continue that session.',
        ].join('\n'),
        'blue',
      ),
    );
  }

  private async showDash(chatId: string): Promise<void> {
    const state = this.sessions.getChatState(chatId);
    const projects = scanProjects();
    const folderNames = [...new Set([...Object.keys(this.config.folders), ...projects.map((p) => p.name)])];
    const fleetSessions = [...this.sessions.allSessions()]
      .slice(0, 5)
      .map((s: ThreadSession) => ({
        id: s.id,
        rootMessageId: s.rootMessageId,
        folder: s.folder,
        title: s.title,
        status: 'active' as const,
        parentSessionId: null as string | null,
        updatedAt: s.createdAt,
        claudeSessionId: s.claudeSessionId,
      }));
    await this.sender.sendCard(
      chatId,
      buildDashCard(state.currentFolder, state.currentWorkingDirectory, fleetSessions, folderNames),
    );
  }

  private async showProjects(chatId: string): Promise<void> {
    const state = this.sessions.getChatState(chatId);
    const projects = scanProjects();
    await this.sender.sendCard(chatId, buildProjectListCard(projects, state.currentWorkingDirectory));
  }

  private async showSessions(chatId: string, page: number = 0): Promise<void> {
    const state = this.sessions.getChatState(chatId);
    const active = getActiveClaudeSessions();

    const fleetSessions = [...this.sessions.allSessions()]
      .filter(
        (s: ThreadSession) =>
          (s.folder === state.currentFolder || state.currentFolder === 'default') && s.claudeSessionId,
      )
      .map((s: ThreadSession) => ({
        id: s.id,
        rootMessageId: s.rootMessageId,
        folder: s.folder,
        title: s.title,
        status: 'active' as const,
        parentSessionId: null as string | null,
        updatedAt: s.createdAt,
        claudeSessionId: s.claudeSessionId,
      }));

    const linkedIds = new Set(fleetSessions.map((s) => s.claudeSessionId).filter(Boolean));
    const claudeSessions = readProjectSessions(state.currentWorkingDirectory, 20).filter(
      (cs) => !linkedIds.has(cs.sessionId),
    );

    // Build previews only for the visible page (5 items)
    const PAGE_SIZE = 5;
    const allIds = [
      ...fleetSessions.map((s) => s.claudeSessionId).filter(Boolean) as string[],
      ...claudeSessions.map((cs) => cs.sessionId),
    ];
    const pageIds = allIds.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const sessionPreviews = new Map<string, string>();
    for (const sid of pageIds) {
      const msgs = tailSession(state.currentWorkingDirectory, sid, 4);
      if (msgs.length > 0) {
        const lines = msgs.map((m) => {
          const icon = m.role === 'user' ? '💬' : m.role === 'assistant' ? '🤖' : '📊';
          return `${icon} ${m.summary.slice(0, 120)}`;
        });
        sessionPreviews.set(sid, lines.join('\n'));
      }
    }

    await this.sender.sendCard(
      chatId,
      buildSessionListCard(fleetSessions, state.currentFolder, claudeSessions, state.currentWorkingDirectory, active, sessionPreviews, page),
    );
  }

  async switchFolder(chatId: string, name: string): Promise<void> {
    if (!name) {
      const s = this.sessions.getChatState(chatId);
      await this.sender.sendCard(
        chatId,
        buildTextCard('Current', `📁 **${s.currentFolder}**\n\`${s.currentWorkingDirectory}\``, 'blue'),
      );
      return;
    }
    let dir: string | undefined = this.config.folders[name];
    if (!dir) {
      const match = scanProjects().find((p) => p.name === name);
      dir = match?.dir;
    }
    if (!dir) {
      await this.sender.sendCard(chatId, buildTextCard('Not Found', `Folder \`${name}\` not found. Use \`/cd <path>\`.`, 'red'));
      return;
    }
    this.sessions.setChatState(chatId, { currentFolder: name, currentWorkingDirectory: dir });
    this.logger.info({ folder: name, dir }, 'Switched folder');
    // Immediately show sessions for this folder
    await this.showSessions(chatId);
  }

  private async setDirectory(chatId: string, dirPath: string): Promise<void> {
    if (!dirPath) {
      const s = this.sessions.getChatState(chatId);
      await this.sender.sendCard(
        chatId,
        buildTextCard('Current', `📁 **${s.currentFolder}**\n\`${s.currentWorkingDirectory}\``, 'blue'),
      );
      return;
    }
    const folderName = dirPath.split('/').pop() || dirPath;
    this.sessions.setChatState(chatId, { currentFolder: folderName, currentWorkingDirectory: dirPath });
    await this.sender.sendCard(chatId, buildTextCard('Set', `📁 **${folderName}** → \`${dirPath}\``, 'green'));
  }

  private async listFolders(chatId: string): Promise<void> {
    const s = this.sessions.getChatState(chatId);
    const projects = scanProjects();
    const all = new Map<string, string>();
    for (const [k, v] of Object.entries(this.config.folders)) all.set(k, v);
    for (const p of projects) if (!all.has(p.name)) all.set(p.name, p.dir);
    const lines = [...all.entries()].map(([n, d]) => `${n === s.currentFolder ? '●' : '○'} **${n}** → \`${d}\``);
    await this.sender.sendCard(chatId, buildTextCard('Folders', lines.join('\n'), 'blue'));
  }

  private async resetSession(chatId: string, rootId?: string): Promise<void> {
    if (!rootId) {
      await this.sender.sendCard(chatId, buildTextCard('Reset', 'Use inside a thread.', 'yellow'));
      return;
    }
    const session = this.sessions.getByRoot(rootId);
    if (!session) {
      await this.sender.sendCard(chatId, buildTextCard('Error', 'No session found.', 'red'));
      return;
    }
    session.claudeSessionId = null;
    this.sessions.save(session);
    await this.sender.sendCard(chatId, buildTextCard('Reset', 'Fresh conversation next message.', 'green'));
  }

  private async searchSessions(chatId: string, query: string): Promise<void> {
    const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
    const state = this.sessions.getChatState(chatId);
    const active = getActiveClaudeSessions();

    let allSessions: Array<{ sessionId: string; summary?: string; customTitle?: string; firstPrompt?: string; lastModified: number; cwd?: string }>;
    try {
      allSessions = await listSessions() as typeof allSessions;
    } catch (err) {
      this.logger.error({ err }, 'listSessions failed');
      await this.sender.sendCard(chatId, buildTextCard('Error', 'Failed to list sessions.', 'red'));
      return;
    }

    const q = query.toLowerCase();
    const matched = allSessions.filter((s) => {
      const text = `${s.summary || ''} ${s.customTitle || ''} ${s.firstPrompt || ''}`.toLowerCase();
      return text.includes(q);
    }).slice(0, 20);

    if (matched.length === 0) {
      await this.sender.sendCard(chatId, buildTextCard('Search', `No sessions matching \`${query}\`.`, 'yellow'));
      return;
    }

    const claudeSessions = matched.map((s) => ({
      title: s.customTitle || s.summary || s.firstPrompt || '(untitled)',
      time: s.lastModified,
      sessionId: s.sessionId,
    }));

    // Build previews for first page
    const sessionPreviews = new Map<string, string>();
    for (const cs of claudeSessions.slice(0, 5)) {
      const wd = (allSessions.find((s) => s.sessionId === cs.sessionId)?.cwd) || state.currentWorkingDirectory;
      const msgs = tailSession(wd, cs.sessionId, 4);
      if (msgs.length > 0) {
        const lines = msgs.map((m) => {
          const icon = m.role === 'user' ? '💬' : m.role === 'assistant' ? '🤖' : '📊';
          return `${icon} ${m.summary.slice(0, 120)}`;
        });
        sessionPreviews.set(cs.sessionId, lines.join('\n'));
      }
    }

    await this.sender.sendCard(
      chatId,
      buildSessionListCard([], `search: ${query}`, claudeSessions, state.currentWorkingDirectory, active, sessionPreviews),
    );
  }
}
