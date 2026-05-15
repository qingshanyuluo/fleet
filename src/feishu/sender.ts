import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logger.js';

export class Sender {
  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  /** Send a card as a new top-level message (no thread) */
  async sendCard(chatId: string, cardJson: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: cardJson,
          msg_type: 'interactive',
        },
      });
      const messageId = resp?.data?.message_id;
      if (!messageId) {
        this.logger.error({ resp: JSON.stringify(resp) }, 'sendCard: no message_id in response');
      }
      return messageId;
    } catch (err) {
      const axErr = err as { response?: { data?: unknown } };
      this.logger.error({ err, chatId, responseData: axErr.response?.data }, 'sendCard failed');
      return undefined;
    }
  }

  /** Send a card as a reply in a thread (uses reply endpoint) */
  async replyCard(replyToMessageId: string, cardJson: string): Promise<string | undefined> {
    try {
      const resp = await this.client.request({
        method: 'POST',
        url: `/open-apis/im/v1/messages/${replyToMessageId}/reply`,
        data: {
          content: cardJson,
          msg_type: 'interactive',
        },
      });
      const data = resp as { data?: { message_id?: string } };
      const messageId = data?.data?.message_id;
      if (!messageId) {
        this.logger.error({ resp: JSON.stringify(resp) }, 'replyCard: no message_id in response');
      }
      return messageId;
    } catch (err) {
      this.logger.error({ err, replyToMessageId }, 'replyCard failed');
      return undefined;
    }
  }

  async updateCard(messageId: string, cardJson: string): Promise<boolean> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: cardJson },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, messageId }, 'updateCard failed');
      return false;
    }
  }

  async downloadImage(messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });
      if (resp) {
        await (resp as Record<string, unknown>).writeFile as (path: string) => Promise<void>;
        const r = resp as { writeFile(p: string): Promise<void> };
        await r.writeFile(savePath);
        this.logger.info({ imageKey, savePath }, 'Image downloaded');
        return true;
      }
      return false;
    } catch (err) {
      this.logger.error({ err, messageId, imageKey }, 'downloadImage failed');
      return false;
    }
  }

  async downloadFile(messageId: string, fileKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });
      if (resp) {
        const r = resp as { writeFile(p: string): Promise<void> };
        await r.writeFile(savePath);
        this.logger.info({ fileKey, savePath }, 'File downloaded');
        return true;
      }
      return false;
    } catch (err) {
      this.logger.error({ err, messageId, fileKey }, 'downloadFile failed');
      return false;
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    } catch (err) {
      this.logger.error({ err, chatId }, 'sendText failed');
    }
  }

  async replyText(replyToMessageId: string, text: string): Promise<void> {
    try {
      await this.client.request({
        method: 'POST',
        url: `/open-apis/im/v1/messages/${replyToMessageId}/reply`,
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    } catch (err) {
      this.logger.error({ err, replyToMessageId }, 'replyText failed');
    }
  }

  async sendImageFile(chatId: string, filePath: string, rootId?: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(filePath),
        },
      });
      const data = resp as Record<string, unknown>;
      const imageKey = data?.image_key as string | undefined;
      if (!imageKey) return false;

      const sendData: {
        receive_id: string;
        content: string;
        msg_type: string;
        root_id?: string;
      } = {
        receive_id: chatId,
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: 'image',
      };
      if (rootId) {
        sendData.root_id = rootId;
      }
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: sendData,
      });
      return true;
    } catch (err) {
      this.logger.error({ err, filePath, chatId }, 'sendImageFile failed');
      return false;
    }
  }
}
