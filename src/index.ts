import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Sender } from './sender.js';
import { createEventDispatcher } from './event-handler.js';
import { Bridge } from './bridge.js';
import type { IncomingMessage, CardActionEvent } from './types.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.log.level);

  const client = new lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    disableTokenCache: false,
  });

  let botOpenId: string | undefined;
  try {
    const botInfo: any = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    botOpenId = botInfo?.bot?.open_id;
    if (botOpenId) logger.info({ botOpenId }, 'Bot info fetched');
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Failed to fetch bot info');
  }

  const sender = new Sender(client, logger);
  const bridge = new Bridge(config, logger, sender);

  const dispatcher = createEventDispatcher(
    logger,
    (msg: IncomingMessage) => { bridge.handleMessage(msg).catch(err => logger.error({ err }, 'Bridge error')); },
    (event: CardActionEvent) => { bridge.handleCardAction(event).catch(err => logger.error({ err }, 'Card action error')); },
  );

  const wsClient = new lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  logger.info('Fleet is running');
  logger.info({ cwd: config.defaultWorkingDirectory, model: config.claude.model, folders: Object.keys(config.folders).length }, 'Config');

  const shutdown = () => {
    logger.info('Shutting down...');
    bridge.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
