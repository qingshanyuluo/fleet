import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from './logger.js';
import type { AppConfig } from './config.js';

const isWindows = process.platform === 'win32';

function resolveClaudePath(): string {
  if (process.env.CLAUDE_EXECUTABLE_PATH) return process.env.CLAUDE_EXECUTABLE_PATH;
  try {
    const cmd = isWindows ? 'where claude' : 'which claude';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    return isWindows ? 'claude' : '/usr/local/bin/claude';
  }
}

const CLAUDE_EXECUTABLE = resolveClaudePath();

function hasCredentialsFile(): boolean {
  try {
    return fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
  } catch {
    return false;
  }
}

/** Custom spawn that filters CLAUDE* env vars (prevents nested session errors) and injects API key if configured. */
function createSpawnFn(explicitApiKey?: string): (options: SpawnOptions) => SpawnedProcess {
  const filterAuthVars = !!(explicitApiKey || hasCredentialsFile());
  const alwaysFilter = ['CLAUDE'];
  const authVars = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

  return (options: SpawnOptions): SpawnedProcess => {
    const baseEnv = options.env && Object.keys(options.env).length > 0
      ? { ...process.env, ...options.env }
      : { ...process.env };

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value === undefined) continue;
      if (alwaysFilter.some(p => key.startsWith(p))) continue;
      if (filterAuthVars && authVars.some(v => key.startsWith(v))) continue;
      env[key] = value;
    }
    if (explicitApiKey) {
      env.ANTHROPIC_API_KEY = explicitApiKey;
    }

    const child = spawn(process.execPath, options.args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return child as unknown as SpawnedProcess;
  };
}

// --- Async Queue (for multi-turn input) ---

class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private finished = false;

  enqueue(item: T): void {
    if (this.finished) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  finish(): void {
    this.finished = true;
    for (const resolve of this.resolvers) {
      resolve({ value: undefined as any, done: true });
    }
    this.resolvers = [];
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      const value = this.items.shift()!;
      return { value, done: false };
    }
    if (this.finished) {
      return { value: undefined as any, done: true };
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncQueue<T> {
    return this;
  }
}

// --- Types ---

export interface ExecutionOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  abortController: AbortController;
  model?: string;
  maxTurns?: number;
}

export interface ExecutionHandle {
  stream: AsyncGenerator<SDKMessage>;
  resolveQuestion(toolUseId: string, answers: Record<string, string>): void;
  finish(): void;
}

export type SDKMessage = {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: unknown;
    }>;
  };
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  errors?: string[];
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; contextWindow: number; costUSD: number }>;
  event?: {
    type: string;
    index?: number;
    delta?: { type: string; text?: string };
    content_block?: { type: string; text?: string; name?: string; id?: string };
  };
  parent_tool_use_id?: string | null;
};

// --- Executor ---

export class Executor {
  private config: AppConfig;
  private logger: Logger;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  startExecution(options: ExecutionOptions): ExecutionHandle {
    const { prompt, cwd, sessionId, abortController, model, maxTurns } = options;

    this.logger.info({ cwd, hasSession: !!sessionId }, 'Starting Claude execution');

    const inputQueue = new AsyncQueue<SDKUserMessage>();

    // Initial user message
    const initialMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user' as const, content: prompt },
      parent_tool_use_id: null,
      session_id: sessionId || '',
    };
    inputQueue.enqueue(initialMessage);

    // Build query options
    const queryOptions: Record<string, unknown> = {
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      cwd,
      abortController,
      includePartialMessages: true,
      settingSources: ['user', 'project'],
      spawnClaudeCodeProcess: createSpawnFn(process.env.ANTHROPIC_API_KEY),
      executableArgs: [path.join(path.dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))), 'cli.js')],
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      betas: ['context-1m-2025-08-07'],
    };

    if (this.config.claude.maxTurns != null) {
      queryOptions.maxTurns = this.config.claude.maxTurns;
    }
    if (this.config.claude.maxBudgetUsd != null) {
      queryOptions.maxBudgetUsd = this.config.claude.maxBudgetUsd;
    }
    if (model || this.config.claude.model) {
      queryOptions.model = model || this.config.claude.model;
    }
    if (maxTurns != null) {
      queryOptions.maxTurns = maxTurns;
    }
    if (sessionId) {
      queryOptions.resume = sessionId;
    }

    // PreToolUse hook for AskUserQuestion
    const pendingQuestionResolvers = new Map<string, (answers: Record<string, string>) => void>();

    const askUserQuestionHook = async (
      input: { hook_event_name: string; tool_name: string; tool_input: unknown; tool_use_id: string },
      _toolUseId: string | undefined,
      { signal }: { signal: AbortSignal },
    ): Promise<Record<string, unknown>> => {
      const toolInput = input.tool_input as Record<string, unknown>;
      const id = input.tool_use_id;

      const answers = await new Promise<Record<string, string>>((resolve) => {
        pendingQuestionResolvers.set(id, resolve);

        const timeout = setTimeout(() => {
          if (pendingQuestionResolvers.delete(id)) {
            this.logger.warn({ toolUseId: id }, 'AskUserQuestion hook timed out, returning empty answers');
            resolve({});
          }
        }, 6 * 60 * 1000);

        const onAbort = () => {
          clearTimeout(timeout);
          pendingQuestionResolvers.delete(id);
          resolve({});
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...toolInput, answers },
        },
      };
    };

    queryOptions.hooks = {
      PreToolUse: [{
        matcher: 'AskUserQuestion',
        hooks: [askUserQuestionHook as any],
      }],
    };

    const stream = query({
      prompt: inputQueue,
      options: queryOptions as any,
    });

    const logger = this.logger;

    async function* wrapStream(): AsyncGenerator<SDKMessage> {
      const abortPromise = new Promise<never>((_, reject) => {
        if (abortController.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        abortController.signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });

      const iterator = stream[Symbol.asyncIterator]();

      try {
        while (true) {
          const result = await Promise.race([iterator.next(), abortPromise]);
          if (result.done) break;
          yield result.value as SDKMessage;
        }
      } catch (err: any) {
        if (err.name === 'AbortError' || abortController.signal.aborted) {
          logger.info('Claude execution aborted');
          try { iterator.return?.(undefined); } catch { /* ignore */ }
          return;
        }
        throw err;
      }
    }

    return {
      stream: wrapStream(),
      resolveQuestion: (toolUseId: string, answers: Record<string, string>) => {
        const resolver = pendingQuestionResolvers.get(toolUseId);
        if (resolver) {
          pendingQuestionResolvers.delete(toolUseId);
          logger.info({ toolUseId, answerCount: Object.keys(answers).length }, 'Resolving AskUserQuestion hook');
          resolver(answers);
        } else {
          logger.warn({ toolUseId }, 'No pending AskUserQuestion resolver, falling back to sendAnswer');
          const answerMessage: SDKUserMessage = {
            type: 'user',
            message: {
              role: 'user' as const,
              content: [{ type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify({ answers }) }],
            },
            parent_tool_use_id: null,
            session_id: '',
          };
          inputQueue.enqueue(answerMessage);
        }
      },
      finish: () => {
        inputQueue.finish();
      },
    };
  }
}
