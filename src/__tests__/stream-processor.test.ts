import { describe, it, expect } from 'vitest';
import { StreamProcessor } from '../core/stream-processor.js';
import type { SDKMessage } from '../core/executor.js';

describe('StreamProcessor', () => {
  it('starts in thinking status', () => {
    const sp = new StreamProcessor('Hello');
    const state = sp.getCurrentState();
    expect(state.status).toBe('thinking');
    expect(state.userPrompt).toBe('Hello');
    expect(state.responseText).toBe('');
    expect(state.toolCalls).toEqual([]);
  });

  it('transitions to running on text_delta', () => {
    const sp = new StreamProcessor('Test');
    const msg: SDKMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello world' },
      },
    };
    const state = sp.processMessage(msg);
    expect(state.status).toBe('running');
    expect(state.responseText).toBe('Hello world');
  });

  it('accumulates multiple text deltas', () => {
    const sp = new StreamProcessor('Test');
    sp.processMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'One ' } },
    });
    const state = sp.processMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Two' } },
    });
    expect(state.responseText).toBe('One Two');
  });

  it('tracks tool calls from assistant messages', () => {
    const sp = new StreamProcessor('Test');
    const state = sp.processMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', id: 'tool_1', input: { file_path: '/tmp/test' } },
        ],
      },
    });
    expect(state.status).toBe('running');
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].name).toBe('Read');
    expect(state.toolCalls[0].status).toBe('done');
  });

  it('handles AskUserQuestion as pending question', () => {
    const sp = new StreamProcessor('Test');
    const state = sp.processMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            id: 'q1',
            input: {
              questions: [
                {
                  question: 'What color?',
                  header: 'Color',
                  options: [
                    { label: 'Red', description: 'The color red' },
                    { label: 'Blue', description: 'The color blue' },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
      },
    });
    expect(state.status).toBe('waiting_for_input');
    expect(state.pendingQuestion).not.toBeNull();
    expect(state.pendingQuestion!.toolUseId).toBe('q1');
    expect(state.pendingQuestion!.questions).toHaveLength(1);
  });

  it('marks SDK-handled tools (AskUserQuestion, ExitPlanMode)', () => {
    const sp = new StreamProcessor('Test');
    sp.processMessage({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'q1', input: {} }],
      },
    });
    sp.processMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'ExitPlanMode', id: 'e1', input: { plan_path: '/tmp/plan.md' } },
        ],
      },
    });
    const drained = sp.drainSdkHandledTools();
    expect(drained).toHaveLength(2);
    expect(drained.map((t) => t.name)).toEqual(['AskUserQuestion', 'ExitPlanMode']);
  });

  it('handles result messages with success', () => {
    const sp = new StreamProcessor('Test');
    const state = sp.processMessage({
      type: 'result',
      is_error: false,
      duration_ms: 5000,
      total_cost_usd: 0.05,
    });
    expect(state.status).toBe('complete');
    expect(state.durationMs).toBe(5000);
    expect(state.costUsd).toBe(0.05);
  });

  it('handles result messages with error', () => {
    const sp = new StreamProcessor('Test');
    const state = sp.processMessage({
      type: 'result',
      is_error: true,
      errors: ['Something went wrong'],
    });
    expect(state.status).toBe('error');
    expect(state.errorMessage).toBe('Something went wrong');
  });

  it('tracks session ID from assistant messages', () => {
    const sp = new StreamProcessor('Test');
    sp.processMessage({
      type: 'assistant',
      session_id: 'sess-abc-123',
      message: { content: [] },
    });
    expect(sp.getSessionId()).toBe('sess-abc-123');
  });

  it('clearPendingQuestion resets state', () => {
    const sp = new StreamProcessor('Test');
    sp.processMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            id: 'q1',
            input: {
              questions: [
                {
                  question: 'Test?',
                  header: 'Test',
                  options: [{ label: 'Yes', description: '' }],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
      },
    });
    expect(sp.getPendingQuestion()).not.toBeNull();
    sp.clearPendingQuestion();
    expect(sp.getPendingQuestion()).toBeNull();
  });
});
