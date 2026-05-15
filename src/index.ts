import * as http from 'node:http';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Sender, createEventDispatcher } from './feishu/index.js';
import { Bridge } from './bridge/index.js';
import type { IncomingMessage, CardActionEvent } from './types.js';

const SHUTDOWN_TIMEOUT_MS = 10_000; // matches PM2 kill_timeout minus buffer

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.log.level);
  const startTime = Date.now();

  // ── HTTP health check server ──
  let shuttingDown = false;

  const healthServer = http.createServer((_req, res) => {
    if (shuttingDown) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'shutting_down' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    healthServer.listen(config.healthPort, () => {
      logger.info({ port: config.healthPort }, 'Health check server listening');
      resolve();
    });
    healthServer.once('error', reject);
  });

  // ── Feishu client ──
  const client = new lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    disableTokenCache: false,
  });

  let botOpenId: string | undefined;
  try {
    const botInfo = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    const data = botInfo as { bot?: { open_id?: string } };
    botOpenId = data?.bot?.open_id;
    if (botOpenId) logger.info({ botOpenId }, 'Bot info fetched');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'Failed to fetch bot info');
  }

  const sender = new Sender(client, logger);
  const bridge = new Bridge(config, logger, sender);

  const dispatcher = createEventDispatcher(
    logger,
    (msg: IncomingMessage) => {
      bridge.handleMessage(msg).catch((err) => logger.error({ err }, 'Bridge error'));
    },
    (event: CardActionEvent) => {
      bridge.handleCardAction(event).catch((err) => logger.error({ err }, 'Card action error'));
    },
  );

  const wsClient = new lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  logger.info('Fleet is running');
  logger.info(
    {
      cwd: config.defaultWorkingDirectory,
      model: config.claude.model,
      folders: Object.keys(config.folders).length,
    },
    'Config',
  );

  // ── Graceful shutdown ──
  let shutdownInProgress = false;

  const shutdown = async (signal: string) => {
    if (shutdownInProgress) {
      logger.warn('Shutdown already in progress, forcing exit');
      process.exit(1);
    }
    shutdownInProgress = true;

    logger.info({ signal }, 'Shutting down...');

    // Immediately fail health checks so PM2/load balancer stops sending traffic
    shuttingDown = true;

    // Stop accepting new connections
    healthServer.close();

    // Shutdown with timeout
    const forceExitTimer = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await bridge.destroy();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Error during bridge shutdown');
    }

    clearTimeout(forceExitTimer);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
