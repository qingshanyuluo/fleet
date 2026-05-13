import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from './logger.js';
import type { IncomingMessage, CardActionEvent } from './types.js';

export type MessageHandler = (msg: IncomingMessage) => void;
export type CardActionHandler = (event: CardActionEvent) => void;

export function createEventDispatcher(
  logger: Logger,
  onMessage: MessageHandler,
  onCardAction?: CardActionHandler,
): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});

  // Card action handler — register for both possible event names
  if (onCardAction) {
    const handleCard = (data: any) => {
      logger.info({ data: JSON.stringify(data).slice(0, 300) }, 'Card action');
      try {
        const d = data as any;
        const userId = d.operator?.open_id || d.user?.open_id;
        const messageId = d.context?.open_message_id || d.open_message_id;
        const chatId = d.context?.open_chat_id || d.open_chat_id;
        const raw = d.action?.value || d.value;
        if (!userId || !messageId || !chatId || !raw || typeof raw !== 'object') {
          logger.warn({ data: JSON.stringify(data) }, 'Card action missing fields');
          return { toast: { type: 'error', content: 'Invalid' } };
        }
        onCardAction({ chatId, userId, messageId, value: raw as Record<string, unknown> });
        return { toast: { type: 'success', content: 'OK' } };
      } catch (err) {
        logger.error({ err }, 'Card action error');
        return { toast: { type: 'error', content: 'Error' } };
      }
    };
    dispatcher.register({
      'card.action.trigger': handleCard,
      'card.action.trigger_v1': handleCard,
    });
  }

  // Message handler
  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      try {
        const event = data;
        const message = event.message;
        const sender = event.sender;

        const msgType = message.message_type;
        if (msgType !== 'text' && msgType !== 'post' && msgType !== 'image' && msgType !== 'file') return;

        const userId = sender?.sender_id?.open_id;
        if (!userId) return;

        const chatId = message.chat_id;
        const chatType = message.chat_type || 'p2p';
        const messageId = message.message_id;
        const rootId = message.root_id || undefined;
        const parentId = message.parent_id || undefined;
        const threadId = message.thread_id || undefined;

        let text = '';
        let imageKey: string | undefined;
        let fileKey: string | undefined;
        let fileName: string | undefined;

        if (msgType === 'text') {
          try { text = JSON.parse(message.content).text || ''; } catch { return; }
        } else if (msgType === 'post') {
          try { text = extractTextFromPost(JSON.parse(message.content)); } catch { return; }
        } else if (msgType === 'image') {
          try { imageKey = JSON.parse(message.content).image_key; } catch { return; }
          if (!imageKey) return;
          text = '请分析这张图片';
        } else if (msgType === 'file') {
          try {
            const c = JSON.parse(message.content);
            fileKey = c.file_key; fileName = c.file_name;
          } catch { return; }
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

function extractTextFromPost(content: Record<string, unknown>): string {
  const bodies: Array<Record<string, unknown>> = [];
  if (Array.isArray(content.content)) bodies.push(content);
  else {
    for (const v of Object.values(content)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as any).content)) {
        bodies.push(v as Record<string, unknown>);
      }
    }
  }
  for (const body of bodies) {
    const parts: string[] = [];
    if (typeof body.title === 'string') parts.push(body.title);
    const paragraphs = body.content as unknown[][];
    for (const p of paragraphs) {
      if (!Array.isArray(p)) continue;
      const line = p.filter(e => e && typeof e === 'object' && ((e as any).tag === 'text' || (e as any).tag === 'a') && typeof (e as any).text === 'string').map(e => (e as any).text).join('');
      if (line) parts.push(line);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return '';
}
