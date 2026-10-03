import http from 'http';
import app from './app.js';
import { env, validateEnv } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { initSockets } from './sockets/index.js';

async function bootstrap() {
  validateEnv();
  await connectDB();

  const server = http.createServer(app);
  initSockets(server);

  server.listen(env.port, () => {
    console.log(`[server] listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async (signal) => {
    console.log(`[server] ${signal} received, shutting down...`);
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[server] uncaught exception:', err);
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  console.error('[server] failed to start:', err.message);
  process.exit(1);
});
