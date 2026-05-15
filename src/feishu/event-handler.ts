import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logger.js';
import type { IncomingMessage, CardActionEvent } from '../types.js';

export type MessageHandler = (msg: IncomingMessage) => void;
export type CardActionHandler = (event: CardActionEvent) => void;

/** Raw card action data shape from Feishu WebSocket */
interface RawCardAction {
  operator?: { open_id?: string };
  user?: { open_id?: string };
  context?: { open_message_id?: string; open_chat_id?: string };
  open_message_id?: string;
  open_chat_id?: string;
  action?: { value?: unknown };
  value?: unknown;
}

/** Raw message event data shape from Feishu WebSocket */
interface RawMessageEvent {
  message?: {
    message_type?: string;
    chat_id?: string;
    chat_type?: string;
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    content?: string;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
    };
  };
}

export function createEventDispatcher(
  logger: Logger,
  onMessage: MessageHandler,
  onCardAction?: CardActionHandler,
): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});

  // Card action handler — register for both possible event names
  if (onCardAction) {
    const handleCard = (data: RawCardAction) => {
      logger.info({ data: JSON.stringify(data).slice(0, 300) }, 'Card action');
      try {
        const userId = data.operator?.open_id || data.user?.open_id;
        const messageId = data.context?.open_message_id || data.open_message_id;
        const chatId = data.context?.open_chat_id || data.open_chat_id;
        const raw = data.action?.value || data.value;
        if (!userId || !messageId || !chatId || !raw || typeof raw !== 'object') {
          logger.warn({ data: JSON.stringify(data) }, 'Card action missing fields');
          return { toast: { type: 'error' as const, content: 'Invalid' } };
        }
        onCardAction({ chatId, userId, messageId, value: raw as Record<string, unknown> });
        return { toast: { type: 'success' as const, content: 'OK' } };
      } catch (err) {
        logger.error({ err }, 'Card action error');
        return { toast: { type: 'error' as const, content: 'Error' } };
      }
    };
    dispatcher.register({
      'card.action.trigger': handleCard,
      'card.action.trigger_v1': handleCard,
    });
  }

  // Message handler
  dispatcher.register({
    'im.message.receive_v1': async (data: RawMessageEvent) => {
      try {
        const message = data.message;
        const sender = data.sender;

        if (!message || !sender) return;

        const msgType = message.message_type;
        if (msgType !== 'text' && msgType !== 'post' && msgType !== 'image' && msgType !== 'file') return;

        const userId = sender.sender_id?.open_id;
        if (!userId) return;

        const chatId = message.chat_id;
        if (!chatId) return;

        const chatType = message.chat_type || 'p2p';
        const messageId = message.message_id;
        if (!messageId) return;

        const rootId = message.root_id || undefined;
        const parentId = message.parent_id || undefined;
        const threadId = message.thread_id || undefined;

        let text = '';
        let imageKey: string | undefined;
        let fileKey: string | undefined;
        let fileName: string | undefined;

        if (msgType === 'text') {
          if (!message.content) return;
          try {
            text = JSON.parse(message.content).text || '';
          } catch {
            return;
          }
        } else if (msgType === 'post') {
          if (!message.content) return;
          try {
            text = extractTextFromPost(JSON.parse(message.content) as PostContent);
          } catch {
            return;
          }
        } else if (msgType === 'image') {
          if (!message.content) return;
          try {
            imageKey = JSON.parse(message.content).image_key;
          } catch {
            return;
          }
          if (!imageKey) return;
          text = '请分析这张图片';
        } else if (msgType === 'file') {
          if (!message.content) return;
          try {
            const c = JSON.parse(message.content);
            fileKey = c.file_key;
            fileName = c.file_name;
          } catch {
            return;
          }
          if (!fileKey || !fileName) return;
          text = '请分析这个文件';
        }

        text = text.replace(/@_\w+\s*/g, '').trim();
        text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        if (!text && !imageKey) return;

        logger.info({ chatId, text: text.slice(0, 100), rootId, threadId }, 'Received message');
        onMessage({ messageId, chatId, chatType, userId, text, rootId, parentId, threadId, imageKey, fileKey, fileName });
      } catch (err) {
        logger.error({ err }, 'Message handler error');
      }
    },
  });

  return dispatcher;
}

/** A paragraph element in a Feishu post message */
interface PostTextElement {
  tag?: string;
  text?: string;
}

/** Structure for Feishu post content JSON */
interface PostContent {
  content?: unknown;
  title?: string;
}

function extractTextFromPost(content: PostContent): string {
  const bodies: PostContent[] = [];
  if (Array.isArray(content.content)) {
    bodies.push(content);
  } else if (content && typeof content === 'object') {
    for (const v of Object.values(content)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const item = v as PostContent;
        if (Array.isArray(item.content)) {
          bodies.push(item);
        }
      }
    }
  }
  for (const body of bodies) {
    const parts: string[] = [];
    if (typeof body.title === 'string') parts.push(body.title);
    const paragraphs = body.content as unknown[][] | undefined;
    if (paragraphs) {
      for (const p of paragraphs) {
        if (!Array.isArray(p)) continue;
        const line = p
          .filter(
            (e) =>
              e &&
              typeof e === 'object' &&
              ((e as PostTextElement).tag === 'text' || (e as PostTextElement).tag === 'a') &&
              typeof (e as PostTextElement).text === 'string',
          )
          .map((e) => (e as PostTextElement).text)
          .join('');
        if (line) parts.push(line);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return '';
}
