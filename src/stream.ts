import type { CardState, ToolCall, PendingQuestion, QuestionItem } from './types.js';
import type { SDKMessage } from './executor.js';

const SDK_HANDLED_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

export class StreamProcessor {
  private state: CardState;
  private sessionId: string | undefined;
  private planFilePath: string | undefined;
  private pendingQuestion: PendingQuestion | null = null;
  private pendingSdkTools: Array<{ name: string; toolUseId: string }> = [];
  private activeToolCalls = new Map<string, ToolCall>();

  constructor(userPrompt: string) {
    this.state = {
      status: 'thinking',
      userPrompt,
      responseText: '',
      toolCalls: [],
    };
  }

  processMessage(msg: SDKMessage): CardState {
    switch (msg.type) {
      case 'stream_event': {
        const event = msg.event;
        if (!event) break;

        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'tool_use' && block.name && block.id) {
            this.activeToolCalls.set(block.id, {
              name: block.name,
              detail: '',
              status: 'running',
            });
            this.state.status = 'running';
          }
        }

        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            this.state.responseText += delta.text;
            this.state.status = 'running';
          }
          if (delta?.type === 'input_json_delta' && delta.text) {
            const blockId = event.content_block?.id;
            if (!blockId) {
              // Find the most recent active tool call without detail
              for (const [id, tc] of this.activeToolCalls) {
                if (!tc.detail) {
                  tc.detail += delta.text;
                  break;
                }
              }
            } else {
              const tc = this.activeToolCalls.get(blockId);
              if (tc) {
                tc.detail += delta.text;
              }
            }
          }
        }

        if (event.type === 'content_block_stop') {
          // Tool call completed
          const block = event.content_block;
          if (block?.id) {
            const tc = this.activeToolCalls.get(block.id);
            if (tc) {
              tc.status = 'done';
            }
          }
        }
        break;
      }

      case 'user':
        // In multi-turn, user messages may appear in the stream
        break;

      case 'assistant': {
        const content = msg.message?.content;
        if (content) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.name && block.id) {
              const detail = typeof block.input === 'string' ? block.input : JSON.stringify(block.input).slice(0, 200);
              // Check if SDK-handled
              if (SDK_HANDLED_TOOLS.has(block.name)) {
                this.pendingSdkTools.push({ name: block.name, toolUseId: block.id });
                // Track AskUserQuestion for pending question display
                if (block.name === 'AskUserQuestion' && block.input && typeof block.input === 'object') {
                  const input = block.input as Record<string, unknown>;
                  const questions = input.questions as QuestionItem[] | undefined;
                  if (questions && questions.length > 0) {
                    this.pendingQuestion = { toolUseId: block.id, questions };
                    this.state.status = 'waiting_for_input';
                    this.state.pendingQuestion = this.pendingQuestion;
                  }
                }
                // Track ExitPlanMode for plan file path
                if (block.name === 'ExitPlanMode' && block.input && typeof block.input === 'object') {
                  const input = block.input as Record<string, unknown>;
                  if (typeof input.plan_path === 'string') {
                    this.planFilePath = input.plan_path;
                  }
                }
              }
              this.activeToolCalls.set(block.id, {
                name: block.name,
                detail,
                status: 'done',
              });
              this.state.status = 'running';
            }
          }
        }
        // Extract session ID
        if (msg.session_id) {
          this.sessionId = msg.session_id;
        }
        break;
      }

      case 'result': {
        this.state.status = msg.is_error ? 'error' : 'complete';
        this.state.errorMessage = msg.errors?.[0];
        if (msg.duration_ms) this.state.durationMs = msg.duration_ms;
        if (msg.total_cost_usd) this.state.costUsd = msg.total_cost_usd;

        // Extract model info from modelUsage
        if (msg.modelUsage) {
          let totalInput = 0;
          let totalOutput = 0;
          let contextWindow = 0;
          const models: string[] = [];
          for (const [modelName, usage] of Object.entries(msg.modelUsage)) {
            models.push(modelName);
            totalInput += usage.inputTokens;
            totalOutput += usage.outputTokens;
            if (usage.contextWindow > contextWindow) {
              contextWindow = usage.contextWindow;
            }
          }
          this.state.totalTokens = totalInput + totalOutput;
          this.state.contextWindow = contextWindow;
          this.state.model = models.join(', ');
        }
        break;
      }
    }

    // Sync toolCalls array from active map
    this.state.toolCalls = Array.from(this.activeToolCalls.values());
    return this.state;
  }

  getCurrentState(): CardState {
    return this.state;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getPlanFilePath(): string | undefined {
    return this.planFilePath;
  }

  getPendingQuestion(): PendingQuestion | null {
    return this.pendingQuestion;
  }

  clearPendingQuestion(): void {
    this.pendingQuestion = null;
    this.state.pendingQuestion = undefined;
  }

  drainSdkHandledTools(): Array<{ name: string; toolUseId: string }> {
    const tools = this.pendingSdkTools;
    this.pendingSdkTools = [];
    return tools;
  }
}
