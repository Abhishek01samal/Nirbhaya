import { io } from 'socket.io-client';
import { TEST_BASE_URL } from './testSetup.js';
import { getAuthToken } from './testUsers.js';

export function connectTestSocket(userKey = 'victim') {
  const token = getAuthToken(userKey);
  const socket = io(TEST_BASE_URL, {
    auth: { token },
    extraHeaders: { Authorization: `Bearer ${token}` },
    transports: ['websocket'],
    reconnection: false,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Socket connection timeout for user ${userKey}`));
    }, 5000);

    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function waitForSocketEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, listener);
      reject(new Error(`Timeout waiting for socket event: "${eventName}"`));
    }, timeoutMs);

    const listener = (data) => {
      clearTimeout(timer);
      socket.off(eventName, listener);
      resolve(data);
    };

    socket.on(eventName, listener);
  });
}
