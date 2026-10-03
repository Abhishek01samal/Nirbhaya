import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { JWT_SECRET } from '../../src/config/env.js';

export const TEST_USERS = {
  victim: {
    id: new mongoose.Types.ObjectId().toHexString(),
    email: 'victim@test.com',
    name: 'Victim User',
    role: 'user',
  },
  guardian1: {
    id: new mongoose.Types.ObjectId().toHexString(),
    email: 'guardian1@test.com',
    name: 'Primary Guardian',
    role: 'user',
  },
  guardian2: {
    id: new mongoose.Types.ObjectId().toHexString(),
    email: 'guardian2@test.com',
    name: 'Secondary Guardian',
    role: 'user',
  },
  responder: {
    id: new mongoose.Types.ObjectId().toHexString(),
    email: 'responder@test.com',
    name: 'Safety Responder',
    role: 'responder',
  },
  unauthorized: {
    id: new mongoose.Types.ObjectId().toHexString(),
    email: 'unauthorized@test.com',
    name: 'Attacker User',
    role: 'user',
  },
};

export async function seedTestUsers() {
  if (mongoose.connection.readyState === 1) {
    const usersCollection = mongoose.connection.collection('users');
    const docs = Object.values(TEST_USERS).map((u) => ({
      _id: new mongoose.Types.ObjectId(u.id),
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await usersCollection.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
    await usersCollection.insertMany(docs);
  }
}

export function getAuthToken(userKey = 'victim') {
  const user = TEST_USERS[userKey] || TEST_USERS.victim;
  return jwt.sign(
    { id: user.id, userId: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET || 'test_secret',
    { expiresIn: '1h' }
  );
}

export function getAuthHeaders(userKey = 'victim') {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getAuthToken(userKey)}`,
  };
}
