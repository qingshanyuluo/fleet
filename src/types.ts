export type CardStatus = 'thinking' | 'running' | 'complete' | 'error' | 'waiting_for_input';

export interface ToolCall {
  name: string;
  detail: string;
  status: 'running' | 'done';
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingQuestion {
  toolUseId: string;
  questions: QuestionItem[];
  sessionId?: string;
}

export interface CardState {
  status: CardStatus;
  userPrompt: string;
  responseText: string;
  toolCalls: ToolCall[];
  costUsd?: number;
  durationMs?: number;
  errorMessage?: string;
  pendingQuestion?: PendingQuestion;
  model?: string;
  totalTokens?: number;
  contextWindow?: number;
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  userId: string;
  text: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
}

export interface CardActionEvent {
  chatId: string;
  userId: string;
  messageId: string;
  value: Record<string, unknown>;
}

/** In-memory session representing a Fleet thread */
export interface ThreadSession {
  /** Fleet's own session id (uuid) */
  id: string;
  /** Feishu root message_id for thread routing */
  rootMessageId: string;
  /** Claude Code session ID */
  claudeSessionId: string | null;
  workingDirectory: string;
  folder: string;
  title: string;
  createdAt: number;
}

/** Chat-level state (current folder) */
export interface ChatState {
  currentFolder: string;
  currentWorkingDirectory: string;
}
