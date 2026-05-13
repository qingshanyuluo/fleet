import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from './logger.js';
import type { AppConfig } from './config.js';
import type { IncomingMessage, CardState, CardActionEvent, PendingQuestion, ThreadSession, ChatState } from './types.js';
import { Sender } from './sender.js';
import { Executor, type ExecutionHandle } from './executor.js';
import { StreamProcessor } from './stream.js';
import { buildCard, buildTextCard, buildForkCard} from './card.js';

const TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const CARD_INTERVAL_MS = 1500;
const FINAL_CARD_RETRIES = 3;
const FINAL_CARD_BASE_DELAY_MS = 2000;

interface RunningTask {
  sessionId: string;
  abortController: AbortController;
  executionHandle: ExecutionHandle;
  processor: StreamProcessor;
  cardMessageId: string;
  chatId: string;
  pendingQuestion: PendingQuestion | null;
  currentQuestionIndex: number;
  collectedAnswers: Record<string, string>;
  questionTimeoutId?: ReturnType<typeof setTimeout>;
}

export class Bridge {
  private executor: Executor;
  private logger: Logger;
  private sender: Sender;
  private config: AppConfig;

  // In-memory state — no DB
  private sessions = new Map<string, ThreadSession>(); // rootMessageId → session
  private sessionsById = new Map<string, ThreadSession>(); // id → session
  private chatStates = new Map<string, ChatState>(); // chatId → current folder
  private runningTasks = new Map<string, RunningTask>(); // sessionId → task
  private pendingMessages = new Map<string, IncomingMessage[]>(); // sessionId → queue

  constructor(config: AppConfig, logger: Logger, sender: Sender) {
    this.config = config;
    this.logger = logger;
    this.sender = sender;
    this.executor = new Executor(config, logger);
  }

  // ── In-memory session helpers ──

  private createSession(opts: { folder: string; workingDir: string; title: string; claudeSessionId?: string }): ThreadSession {
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

  private getSessionByRoot(rootId: string): ThreadSession | undefined {
    return this.sessions.get(rootId);
  }

  private saveSession(session: ThreadSession): void {
    if (session.rootMessageId) {
      this.sessions.set(session.rootMessageId, session);
    }
    this.sessionsById.set(session.id, session);
  }

  private getChatState(chatId: string): ChatState {
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

  // ── Message routing ──

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { text, chatId, rootId } = msg;

    // Commands
    if (text.startsWith('/')) {
      if (text.trim().toLowerCase() === '/stop' && rootId) {
        await this.stopTaskByRoot(chatId, rootId);
        return;
      }
      const handled = await this.handleCommand(msg);
      if (handled) return;
      await this.sendCard(chatId, buildTextCard(
        'Unknown',
        `\`${text.trim().split(/\s+/)[0]}\` not recognized. Use \`/help\`.`,
        'yellow',
      ));
      return;
    }

    // Route to session
    if (rootId) {
      const session = this.getSessionByRoot(rootId);
      if (!session) {
        this.logger.warn({ rootId }, 'No session for this thread, creating new');
        await this.startSession(msg);
        return;
      }
      if (this.runningTasks.has(session.id)) {
        const queue = this.pendingMessages.get(session.id) || [];
        queue.push(msg);
        this.pendingMessages.set(session.id, queue);
        await this.sender.sendText(chatId, `📋 Queued (#${queue.length})`);
        return;
      }
      await this.continueSession(msg, session);
    } else {
      // Main chat: only commands, no Claude. Threads are for conversations.
      await this.sendCard(chatId, buildTextCard(
        'Fleet',
        '在主聊天中用命令管理会话：\n\n`/dash` — 仪表盘\n`/projects` — 浏览项目\n`/list` — 查看会话\n`/folder <name>` — 切换项目\n\n点 **➕ New** 按钮或在 thread 里发消息开始 Claude 对话。',
        'blue',
      ));
    }
  }

  async handleCardAction(event: CardActionEvent): Promise<void> {
    const { chatId, userId, value } = event;
    const action = value.action as string | undefined;
    if (!action) return;

    switch (action) {
      case 'cmd': {
        const cmd = (value.cmd as string) || '';
        const fakeMsg: IncomingMessage = { messageId: '', chatId, chatType: 'p2p', userId, text: `/${cmd}` };
        await this.handleCommand(fakeMsg);
        break;
      }
      case 'new_session':
        await this.startNewThread(chatId);
        break;
      case 'fork': {
        const sid = value.sessionId as string;
        const s = this.sessionsById.get(sid);
        if (s) await this.forkSession(chatId, s);
        break;
      }
      case 'archive': {
        const sid = value.sessionId as string;
        const s = this.sessionsById.get(sid);
        if (s) {
          this.sessions.delete(s.rootMessageId);
          this.sessionsById.delete(s.id);
        }
        await this.handleCommand({ messageId: '', chatId, chatType: 'p2p', userId, text: '/list' });
        break;
      }
      case 'fork_claude': {
        // Fork a running Claude session (native fork via SDK)
        const sid = value.sessionId as string;
        const title = (value.title as string) || '(forked)';
        const wd = (value.workingDir as string) || this.getChatState(chatId).currentWorkingDirectory;
        const folderName = wd.split('/').pop() || wd;
        let newClaudeId: string | null = null;
        try {
          const { forkSession } = await import('@anthropic-ai/claude-agent-sdk');
          const result = await forkSession(sid);
          newClaudeId = result.sessionId;
          this.logger.info({ parent: sid, forked: newClaudeId }, 'Claude native fork');
        } catch (err) {
          this.logger.warn({ err }, 'Fork failed, using fresh');
        }
        const session = this.createSession({ folder: folderName, workingDir: wd, title: `Fork: ${title.slice(0, 60)}`, claudeSessionId: newClaudeId || undefined });
        const card = buildTextCard(title.slice(0, 30), `📁 \`${folderName}\` → \`${wd}\`\n\nForked — 回复此卡片继续`, 'blue');
        const rootId = await this.sender.sendCard(chatId, card);
        if (rootId) { session.rootMessageId = rootId; this.saveSession(session); }
        break;
      }

      case 'resume_claude': {
        const sid = value.sessionId as string;
        const title = (value.title as string) || '(resumed)';
        const wd = (value.workingDir as string) || this.getChatState(chatId).currentWorkingDirectory;
        await this.resumeClaudeSession(chatId, sid, title, wd);
        break;
      }
      case 'answer_question': {
        const sessionId = value.sessionId as string;
        if (!sessionId) break;
        const task = this.runningTasks.get(sessionId);
        if (!task?.pendingQuestion) break;
        const toolUseId = value.toolUseId as string;
        if (toolUseId !== task.pendingQuestion.toolUseId) break;
        const oi = typeof value.optionIndex === 'number' ? value.optionIndex : -1;
        const cq = task.pendingQuestion.questions[task.currentQuestionIndex];
        if (!cq || oi < 0 || oi >= cq.options.length) break;
        const answerText = cq.options[oi].label;
        task.collectedAnswers[cq.header] = answerText;
        if (task.currentQuestionIndex + 1 < task.pendingQuestion.questions.length) {
          task.currentQuestionIndex++;
          this.resetQuestionTimeout(task);
          const nextQ = task.pendingQuestion.questions[task.currentQuestionIndex];
          await this.sender.updateCard(task.cardMessageId, buildCard({
            ...task.processor.getCurrentState(), status: 'waiting_for_input',
            responseText: task.processor.getCurrentState().responseText + `\n\n> **Reply:** ${answerText}`,
            pendingQuestion: { toolUseId, questions: [nextQ] },
          }));
        } else {
          this.resolveQuestion(task);
        }
        break;
      }
    }
  }

  // ── Session lifecycle ──

  private async startSession(msg: IncomingMessage): Promise<void> {
    const state = this.getChatState(msg.chatId);
    const title = msg.text.slice(0, 100).replace(/\n/g, ' ');
    const session = this.createSession({ folder: state.currentFolder, workingDir: state.currentWorkingDirectory, title });
    // Not saved yet — rootMessageId set after card sent

    await this.executeQuery(msg, session, true);
  }

  private async continueSession(msg: IncomingMessage, session: ThreadSession): Promise<void> {
    await this.executeQuery(msg, session, false);
  }

  private async startNewThread(chatId: string): Promise<void> {
    const state = this.getChatState(chatId);
    const session = this.createSession({ folder: state.currentFolder, workingDir: state.currentWorkingDirectory, title: '(new session)' });
    const card = buildTextCard('New Session', `📁 **${state.currentFolder}**\n\`${state.currentWorkingDirectory}\`\n\n回复此卡片开始新对话`, 'blue');
    const rootId = await this.sender.sendCard(chatId, card);
    if (rootId) {
      session.rootMessageId = rootId;
      this.saveSession(session);
    }
  }

  private async resumeClaudeSession(chatId: string, claudeSessionId: string, title: string, workingDir: string): Promise<void> {
    const folderName = workingDir.split('/').pop() || workingDir;
    const session = this.createSession({ folder: folderName, workingDir, title: `Resumed: ${title.slice(0, 80)}`, claudeSessionId });
    const shortTitle = title.slice(0, 30);
    const card = buildTextCard(shortTitle, `📁 \`${folderName}\` → \`${workingDir}\`\n\n回复此卡片继续对话`, 'green');
    const rootId = await this.sender.sendCard(chatId, card);
    if (rootId) {
      session.rootMessageId = rootId;
      this.saveSession(session);
    }
  }

  private async forkSession(chatId: string, parent: ThreadSession): Promise<void> {
    let newClaudeId: string | null = null;
    // Use Claude's native forkSession if parent has a session ID
    if (parent.claudeSessionId) {
      try {
        const { forkSession } = await import('@anthropic-ai/claude-agent-sdk');
        const result = await forkSession(parent.claudeSessionId);
        newClaudeId = result.sessionId;
        this.logger.info({ parent: parent.claudeSessionId, forked: newClaudeId }, 'Claude native fork created');
      } catch (err) {
        this.logger.warn({ err }, 'Claude native fork failed, creating fresh session');
      }
    }
    const session = this.createSession({
      folder: parent.folder, workingDir: parent.workingDirectory,
      title: `Fork: ${parent.title.slice(0, 60)}`,
      claudeSessionId: newClaudeId || undefined,
    });
    const card = buildForkCard(parent.title, parent.workingDirectory, parent.folder);
    const rootId = await this.sendCard(chatId, card);
    if (rootId) {
      session.rootMessageId = rootId;
      this.saveSession(session);
    }
  }

  // ── Command handler ──

  async handleCommand(msg: IncomingMessage): Promise<boolean> {
    const { text, chatId } = msg;
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    switch (cmd) {
      case '/help':
        await this.sendCard(chatId, buildTextCard('Fleet Help', [
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
        ].join('\n'), 'blue'));
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
        await this.showSessions(chatId);
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
        await this.sendCard(chatId, buildTextCard('Stop', 'Use `/stop` inside a thread.', 'yellow'));
        return true;
      case '/reset':
        await this.resetSession(chatId, msg.rootId);
        return true;
    }
    return false;
  }

  private async showDash(chatId: string): Promise<void> {
    const state = this.getChatState(chatId);
    const { scanProjects } = await import('./projects.js');
    const projects = scanProjects();
    const folderNames = [...new Set([...Object.keys(this.config.folders), ...projects.map(p => p.name)])];
    const { buildDashCard } = await import('./card.js');
    const fleetSessions = [...this.sessionsById.values()].slice(0, 5).map(s => ({
      id: s.id, rootMessageId: s.rootMessageId, folder: s.folder, title: s.title,
      status: 'active', parentSessionId: null, updatedAt: s.createdAt,
      claudeSessionId: s.claudeSessionId,
    }));
    await this.sendCard(chatId, buildDashCard(state.currentFolder, state.currentWorkingDirectory, fleetSessions, folderNames));
  }

  private async showProjects(chatId: string): Promise<void> {
    const state = this.getChatState(chatId);
    const { scanProjects, getActiveClaudeSessions } = await import('./projects.js');
    const projects = scanProjects();
    const active = getActiveClaudeSessions();
    const { buildProjectListCard } = await import('./card.js');
    await this.sendCard(chatId, buildProjectListCard(projects, state.currentWorkingDirectory));
  }

  private async showSessions(chatId: string): Promise<void> {
    const state = this.getChatState(chatId);
    const { readProjectSessions, getActiveClaudeSessions } = await import('./projects.js');
    const active = getActiveClaudeSessions();

    const fleetSessions = [...this.sessionsById.values()]
      .filter(s => (s.folder === state.currentFolder || state.currentFolder === 'default') && s.claudeSessionId)
      .map(s => ({
        id: s.id, rootMessageId: s.rootMessageId, folder: s.folder, title: s.title,
        status: 'active', parentSessionId: null, updatedAt: s.createdAt,
        claudeSessionId: s.claudeSessionId,
      }));

    const linkedIds = new Set(fleetSessions.map(s => s.claudeSessionId).filter(Boolean));
    const claudeSessions = readProjectSessions(state.currentWorkingDirectory, 20)
      .filter(cs => !linkedIds.has(cs.sessionId));

    const { buildSessionListCard } = await import('./card.js');
    await this.sendCard(chatId, buildSessionListCard(fleetSessions, state.currentFolder, claudeSessions, state.currentWorkingDirectory, active));
  }

  private async switchFolder(chatId: string, name: string): Promise<void> {
    if (!name) {
      const s = this.getChatState(chatId);
      await this.sendCard(chatId, buildTextCard('Current', `📁 **${s.currentFolder}**\n\`${s.currentWorkingDirectory}\``, 'blue'));
      return;
    }
    let dir = this.config.folders[name];
    if (!dir) {
      const { scanProjects } = await import('./projects.js');
      const match = scanProjects().find(p => p.name === name);
      dir = match?.dir;
    }
    if (!dir) {
      await this.sendCard(chatId, buildTextCard('Not Found', `Folder \`${name}\` not found. Use \`/cd <path>\`.`, 'red'));
      return;
    }
    this.chatStates.set(chatId, { currentFolder: name, currentWorkingDirectory: dir });
    this.logger.info({ folder: name, dir }, 'Switched folder');
    // Immediately show sessions for this folder
    await this.showSessions(chatId);
  }

  private async setDirectory(chatId: string, dirPath: string): Promise<void> {
    if (!dirPath) {
      const s = this.getChatState(chatId);
      await this.sendCard(chatId, buildTextCard('Current', `📁 **${s.currentFolder}**\n\`${s.currentWorkingDirectory}\``, 'blue'));
      return;
    }
    const folderName = dirPath.split('/').pop() || dirPath;
    this.chatStates.set(chatId, { currentFolder: folderName, currentWorkingDirectory: dirPath });
    await this.sendCard(chatId, buildTextCard('Set', `📁 **${folderName}** → \`${dirPath}\``, 'green'));
  }

  private async listFolders(chatId: string): Promise<void> {
    const s = this.getChatState(chatId);
    const { scanProjects } = await import('./projects.js');
    const projects = scanProjects();
    const all = new Map<string, string>();
    for (const [k, v] of Object.entries(this.config.folders)) all.set(k, v);
    for (const p of projects) if (!all.has(p.name)) all.set(p.name, p.dir);
    const lines = [...all.entries()].map(([n, d]) => `${n === s.currentFolder ? '●' : '○'} **${n}** → \`${d}\``);
    await this.sendCard(chatId, buildTextCard('Folders', lines.join('\n'), 'blue'));
  }

  private async resetSession(chatId: string, rootId?: string): Promise<void> {
    if (!rootId) { await this.sendCard(chatId, buildTextCard('Reset', 'Use inside a thread.', 'yellow')); return; }
    const session = this.getSessionByRoot(rootId);
    if (!session) { await this.sendCard(chatId, buildTextCard('Error', 'No session found.', 'red')); return; }
    session.claudeSessionId = null;
    await this.sendCard(chatId, buildTextCard('Reset', 'Fresh conversation next message.', 'green'));
  }

  // ── Core execution ──

  private async executeQuery(msg: IncomingMessage, session: ThreadSession, isNew: boolean): Promise<void> {
    const { text, chatId, messageId, imageKey, fileKey, fileName, rootId } = msg;
    const cwd = session.workingDirectory;
    const abortController = new AbortController();
    const threadRoot = rootId || session.rootMessageId || undefined;

    const downloadDir = path.join(os.tmpdir(), 'fleet-downloads');
    fs.mkdirSync(downloadDir, { recursive: true });

    let prompt = text || '请分析';
    if (imageKey) {
      const imgPath = path.join(downloadDir, `${imageKey}.png`);
      if (await this.sender.downloadImage(messageId, imageKey, imgPath)) {
        prompt = `${text}\n\n[Image: ${imgPath}]\nPlease use Read tool to analyze.`;
      }
    }
    if (fileKey && fileName) {
      const filePath = path.join(downloadDir, `${fileKey}_${fileName}`);
      if (await this.sender.downloadFile(messageId, fileKey, filePath)) {
        prompt = `${text}\n\n[File: ${filePath}]\nPlease use Read tool to analyze.`;
      }
    }

    const displayPrompt = imageKey ? `🖼️ ${text}` : fileKey ? `📎 ${text}` : text;
    const processor = new StreamProcessor(displayPrompt);
    let cardMessageId: string | undefined;

    if (isNew || !session.rootMessageId) {
      cardMessageId = await this.sender.replyCard(messageId, buildCard(processor.getCurrentState()));
      if (!cardMessageId) { this.logger.error('Failed to send initial card'); return; }
      session.rootMessageId = messageId; // user's message is the thread root
      this.saveSession(session);
    } else {
      cardMessageId = await this.sendCard(chatId, buildCard(processor.getCurrentState()), threadRoot);
      if (!cardMessageId) { this.logger.error('Failed to send continuation card'); return; }
    }

    const executionHandle = this.executor.startExecution({ prompt, cwd, sessionId: session.claudeSessionId ?? undefined, abortController });
    const task: RunningTask = {
      sessionId: session.id, abortController, executionHandle, processor,
      cardMessageId, chatId, pendingQuestion: null, currentQuestionIndex: 0, collectedAnswers: {},
    };
    this.runningTasks.set(session.id, task);

    let timedOut = false, idledOut = false;
    const timeoutId = setTimeout(() => { timedOut = true; executionHandle.finish(); abortController.abort(); }, TASK_TIMEOUT_MS);
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (idleTimerId) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => { idledOut = true; executionHandle.finish(); abortController.abort(); }, IDLE_TIMEOUT_MS);
    };
    resetIdleTimer();

    let lastState: CardState = { status: 'thinking', userPrompt: displayPrompt, responseText: '', toolCalls: [] };
    let lastUpdateTime = 0;
    let pendingUpdateTimer: ReturnType<typeof setTimeout> | undefined;

    const throttledUpdate = (state: CardState) => {
      const now = Date.now(), elapsed = now - lastUpdateTime;
      if (elapsed >= CARD_INTERVAL_MS) { lastUpdateTime = now; this.sender.updateCard(cardMessageId, buildCard(state)); }
      else {
        if (pendingUpdateTimer) clearTimeout(pendingUpdateTimer);
        pendingUpdateTimer = setTimeout(() => { lastUpdateTime = Date.now(); this.sender.updateCard(cardMessageId, buildCard(state)); }, CARD_INTERVAL_MS - elapsed);
      }
    };
    const flushPending = async (state: CardState) => {
      if (pendingUpdateTimer) clearTimeout(pendingUpdateTimer);
      pendingUpdateTimer = undefined;
      await this.sender.updateCard(cardMessageId, buildCard(state));
    };

    try {
      for await (const sdkMsg of executionHandle.stream) {
        if (abortController.signal.aborted) break;
        resetIdleTimer();
        const state = processor.processMessage(sdkMsg);
        lastState = state;

        const sid = processor.getSessionId();
        if (sid && sid !== session.claudeSessionId) {
          session.claudeSessionId = sid;
          this.saveSession(session);
        }

        if (state.status === 'waiting_for_input' && state.pendingQuestion) {
          if (!task.pendingQuestion || task.pendingQuestion.toolUseId !== state.pendingQuestion.toolUseId) {
            task.pendingQuestion = state.pendingQuestion;
            task.currentQuestionIndex = 0;
            task.collectedAnswers = {};
          }
          await flushPending(state);
          const pending = task.pendingQuestion;
          const currentQ = pending.questions[task.currentQuestionIndex];
          const progress = pending.questions.length > 1 ? ` (${task.currentQuestionIndex + 1}/${pending.questions.length})` : '';
          await this.sender.updateCard(cardMessageId, buildCard({
            ...state,
            pendingQuestion: { toolUseId: pending.toolUseId, questions: currentQ ? [currentQ] : pending.questions },
            responseText: state.responseText + (progress ? `\n\n_Question${progress}_` : ''),
          }));
          this.resetQuestionTimeout(task);
          continue;
        }

        const sdkTools = processor.drainSdkHandledTools();
        for (const tool of sdkTools) {
          if (tool.name === 'ExitPlanMode') {
            const planPath = processor.getPlanFilePath();
            if (planPath) {
              try {
                const content = await fs.promises.readFile(planPath, 'utf-8');
                if (content.trim()) await this.sendCard(chatId, buildTextCard('Plan', content.slice(0, 8000), 'green'), threadRoot);
              } catch { /* ignore */ }
            }
          }
        }

        if (task.pendingQuestion === null && task.questionTimeoutId) {
          clearTimeout(task.questionTimeoutId);
          task.questionTimeoutId = undefined;
        }

        if (state.status === 'complete' || state.status === 'error') break;
        throttledUpdate(state);
      }

      await flushPending(lastState);
      if (lastState.status !== 'complete' && lastState.status !== 'error') {
        lastState = { ...lastState, status: timedOut ? 'error' : idledOut ? 'error' : abortController.signal.aborted ? 'error' : lastState.responseText ? 'complete' : 'error',
          errorMessage: timedOut ? 'Timed out (24h)' : idledOut ? 'Idle timeout (1h)' : abortController.signal.aborted ? 'Stopped' : undefined };
      }

      // Stale session retry
      if (lastState.status === 'error' && isStaleSessionError(lastState.errorMessage) && session.claudeSessionId) {
        await this.retryWithFreshSession(session, prompt, cwd, abortController, processor, task, lastState, cardMessageId, chatId);
        return;
      }
      // Context overflow retry
      if (lastState.status === 'error' && isContextOverflowError(lastState.errorMessage) && session.claudeSessionId) {
        await this.retryWithFreshSession(session, prompt, cwd, abortController, processor, task, lastState, cardMessageId, chatId);
        return;
      }

      await this.sendFinalCard(cardMessageId, lastState);

    } catch (err: any) {
      this.logger.error({ err }, 'Execution error');
      const errMsg = err.message || '';
      if ((isStaleSessionError(errMsg) || isContextOverflowError(errMsg)) && session.claudeSessionId) {
        try { await this.retryWithFreshSession(session, prompt, cwd, abortController, processor, task, lastState, cardMessageId, chatId); return; } catch { /* fall through */ }
      }
      lastState = { ...lastState, status: 'error', errorMessage: errMsg || 'Unknown error' };
      await flushPending(lastState);
      await this.sendFinalCard(cardMessageId, lastState);
    } finally {
      clearTimeout(timeoutId);
      if (idleTimerId) clearTimeout(idleTimerId);
      if (task.questionTimeoutId) clearTimeout(task.questionTimeoutId);
      try { executionHandle.finish(); } catch { /* ignore */ }
      this.runningTasks.delete(session.id);
      const queue = this.pendingMessages.get(session.id);
      if (queue?.length) {
        const next = queue.shift()!;
        this.pendingMessages.set(session.id, queue);
        if (queue.length === 0) this.pendingMessages.delete(session.id);
        this.handleMessage(next).catch(e => this.logger.error({ err: e }, 'Queue error'));
      }
    }
  }

  private async retryWithFreshSession(session: ThreadSession, prompt: string, cwd: string, abortController: AbortController, processor: StreamProcessor, task: RunningTask, lastState: CardState, cardMessageId: string, chatId: string): Promise<void> {
    session.claudeSessionId = null;
    this.saveSession(session);
    await this.sender.updateCard(cardMessageId, buildCard({ ...lastState, status: 'running', errorMessage: undefined, responseText: '_Session expired, retrying..._' }));
    const retryHandle = this.executor.startExecution({ prompt, cwd, sessionId: undefined, abortController });
    task.executionHandle.finish();
    task.executionHandle = retryHandle;
    for await (const sdkMsg of retryHandle.stream) {
      if (abortController.signal.aborted) break;
      const state = processor.processMessage(sdkMsg);
      lastState = state;
      const sid = processor.getSessionId();
      if (sid) { session.claudeSessionId = sid; this.saveSession(session); }
      if (state.status === 'complete' || state.status === 'error') break;
      this.sender.updateCard(cardMessageId, buildCard(state));
    }
    await this.sender.updateCard(cardMessageId, buildCard(lastState));
    await this.sendFinalCard(cardMessageId, lastState);
  }

  private async sendFinalCard(messageId: string, state: CardState): Promise<void> {
    for (let attempt = 0; attempt < FINAL_CARD_RETRIES; attempt++) {
      if (await this.sender.updateCard(messageId, buildCard(state))) return;
      await new Promise(r => setTimeout(r, FINAL_CARD_BASE_DELAY_MS * Math.pow(2, attempt)));
    }
  }

  // ── Helpers ──

  private async sendCard(chatId: string, cardJson: string, threadRoot?: string): Promise<string | undefined> {
    if (threadRoot) return this.sender.replyCard(threadRoot, cardJson);
    return this.sender.sendCard(chatId, cardJson);
  }

  private resolveQuestion(task: RunningTask): void {
    const collected = task.collectedAnswers;
    const pending = task.pendingQuestion!;
    if (task.questionTimeoutId) { clearTimeout(task.questionTimeoutId); task.questionTimeoutId = undefined; }
    task.pendingQuestion = null;
    task.currentQuestionIndex = 0;
    task.collectedAnswers = {};
    task.processor.clearPendingQuestion();
    task.executionHandle.resolveQuestion(pending.toolUseId, collected);
  }

  private resetQuestionTimeout(task: RunningTask): void {
    if (task.questionTimeoutId) clearTimeout(task.questionTimeoutId);
    task.questionTimeoutId = setTimeout(() => {
      const pending = task.pendingQuestion;
      if (!pending) return;
      for (let i = task.currentQuestionIndex; i < pending.questions.length; i++) {
        if (!task.collectedAnswers[pending.questions[i].header]) {
          task.collectedAnswers[pending.questions[i].header] = '用户未及时回复，请自行判断继续';
        }
      }
      this.resolveQuestion(task);
    }, QUESTION_TIMEOUT_MS);
  }

  private async stopTaskByRoot(chatId: string, rootId: string): Promise<void> {
    const session = this.getSessionByRoot(rootId);
    if (!session) return;
    const task = this.runningTasks.get(session.id);
    if (!task) return;
    task.executionHandle.finish();
    task.abortController.abort();
    await this.sender.replyText(rootId, '⏹ Stopped.');
  }

  destroy(): void {
    for (const [, task] of this.runningTasks) {
      try { task.executionHandle.finish(); } catch { /* ignore */ }
      task.abortController.abort();
    }
  }
}

function isStaleSessionError(msg?: string): boolean {
  if (!msg) return false;
  return /no conversation found|conversation not found|session id|invalid session|multiple.*tool_result/i.test(msg);
}

function isContextOverflowError(msg?: string): boolean {
  if (!msg) return false;
  return /context.window.exceeds.limit|context.length.exceeded|token.limit.exceeded|maximum.context/i.test(msg);
}
