import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { KnowledgeChunk } from '../src/modules/assistant/knowledgeChunk.model.js';

async function seedKnowledgeChunks() {
  console.log('[seeder] Connecting to MongoDB...');
  await connectDB();

  const jsonPath = path.resolve('brain/Nirbhaya.knowledgechunks.json');
  console.log(`[seeder] Reading knowledge chunks from: ${jsonPath}`);

  if (!fs.existsSync(jsonPath)) {
    console.error(`[seeder] File not found: ${jsonPath}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(jsonPath, 'utf-8');
  const chunks = JSON.parse(rawData);

  console.log(`[seeder] Found ${chunks.length} chunks in JSON file.`);

  // Clean data format if needed
  const formattedChunks = chunks.map((chunk) => {
    const item = { ...chunk };
    // Remove mongo export envelope keys if present
    if (item.createdAt && item.createdAt.$date) {
      item.createdAt = new Date(item.createdAt.$date);
    }
    if (item.updatedAt && item.updatedAt.$date) {
      item.updatedAt = new Date(item.updatedAt.$date);
    }
    return item;
  });

  console.log('[seeder] Upserting chunks into MongoDB...');

  const operations = formattedChunks.map((chunk) => ({
    updateOne: {
      filter: { _id: chunk._id },
      update: { $set: chunk },
      upsert: true,
    },
  }));

  const result = await KnowledgeChunk.bulkWrite(operations, { ordered: false });

  console.log(`[seeder] Successfully seeded knowledge chunks!`);
  console.log(` - Upserted: ${result.upsertedCount}`);
  console.log(` - Modified: ${result.modifiedCount}`);
  console.log(` - Total Chunks in Collection: ${await KnowledgeChunk.countDocuments()}`);

  await disconnectDB();
  process.exit(0);
}

seedKnowledgeChunks().catch((err) => {
  console.error('[seeder] Error seeding knowledge chunks:', err);
  process.exit(1);
});
