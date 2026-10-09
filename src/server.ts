import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './database/connection.js';
import { runMigrations } from './database/migrations.js';
import { registerJobs, scheduleJobs } from './jobs/index.js';
import { startWorkers, stopJobs } from './jobs/queue.js';
import { closeSockets, initSockets } from './sockets/index.js';

async function main() {
  await connectDatabase();
  await runMigrations();
  registerJobs();
  startWorkers();
  await scheduleJobs();
  const app = createApp();
  const server = createServer(app);
  initSockets(server);

  server.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT} (docs: /api/docs)`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 15_000).unref();
    server.close();
    await closeSockets();
    await stopJobs();
    await disconnectDatabase();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
