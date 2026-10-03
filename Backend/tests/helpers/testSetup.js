import http from 'http';
import mongoose from 'mongoose';
import app from '../../src/app.js';
import { initSockets, getIO } from '../../src/sockets/index.js';
import { connectDB, disconnectDB } from '../../src/config/db.js';

export const TEST_PORT = 4005;
export const TEST_BASE_URL = `http://localhost:${TEST_PORT}`;

let server = null;

export async function startTestServer() {
  if (server) return server;

  // Use test DB URI if provided or append _test suffix
  const origUri = process.env.MONGODB_URI;
  if (origUri && !origUri.includes('_test')) {
    process.env.MONGODB_URI = origUri.replace('/women_safety', '/women_safety_test');
  }

  await connectDB();

  server = http.createServer(app);
  initSockets(server);

  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`[test-harness] Server listening on ${TEST_BASE_URL}`);

  return server;
}

export async function stopTestServer() {
  if (server) {
    const io = getIO();
    if (io) io.close();
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  await disconnectDB();
  console.log(`[test-harness] Server and DB stopped.`);
}

export async function clearTestCollections() {
  if (mongoose.connection.readyState === 1) {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  }
}
