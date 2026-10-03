import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

import { RAG_CHUNK_SIZE, RAG_CHUNK_OVERLAP, JINA_EMBEDDING_MODEL } from "../../config/env.js";
import { chunkMarkdown, knowledgeTypeFor } from "./knowledgeChunker.service.js";
import { embedTexts } from "./jinaEmbedding.service.js";
import { upsertChunks, removeStaleChunks, getChunksBySource } from "./vectorStore.service.js";

const SERVER_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KNOWLEDGE_DIRS = ["knowledge_for_chatbot", "knowledge"];

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function chunkIdFor(source, docHash, chunkIndex) {
  return sha256(`${source}|${docHash}|${chunkIndex}`);
}

async function discoverKnowledgeFiles() {
  const files = [];

  for (const dirName of KNOWLEDGE_DIRS) {
    const dir = path.join(SERVER_ROOT, dirName);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;

      files.push({
        source: entry.name,
        filePath: path.join(dir, entry.name),
        knowledgeType: knowledgeTypeFor(entry.name),
      });
    }
  }

  return files.sort((a, b) => a.source.localeCompare(b.source));
}

function isIdentical(existing, chunks) {
  if (existing.length !== chunks.length) return false;

  const byId = new Map(existing.map((doc) => [String(doc._id), doc]));

  return chunks.every((chunk) => {
    const doc = byId.get(chunk.id);
    return doc && doc.content === chunk.content && doc.docHash === chunk.docHash;
  });
}

async function ingestFile(file, log) {
  const content = await fs.readFile(file.filePath, "utf8");
  const docHash = sha256(content);

  const chunks = chunkMarkdown(content, {
    source: file.source,
    knowledgeType: file.knowledgeType,
    chunkSize: RAG_CHUNK_SIZE,
    chunkOverlap: RAG_CHUNK_OVERLAP,
  }).map((chunk) => ({
    ...chunk,
    id: chunkIdFor(file.source, docHash, chunk.chunkIndex),
    docHash,
    embeddingModel: JINA_EMBEDDING_MODEL,
  }));

  const existing = await getChunksBySource(file.source);

  if (isIdentical(existing, chunks)) {
    log(`  = ${file.source}: unchanged (${chunks.length} chunks already embedded)`);
    return { source: file.source, chunks: chunks.length, action: "unchanged", vectors: 0 };
  }

  log(`  → ${file.source}: embedding ${chunks.length} chunks...`);

  const vectors = await embedTexts(chunks.map((chunk) => chunk.content));
  chunks.forEach((chunk, index) => {
    chunk.vector = vectors[index];
  });

  const written = await upsertChunks(chunks);
  const removed = await removeStaleChunks(
    file.source,
    chunks.map((chunk) => chunk.id)
  );

  log(
    `  ✓ ${file.source}: ${chunks.length} chunks, ${written} vectors stored` +
      (removed > 0 ? `, ${removed} stale vectors removed` : "")
  );

  return { source: file.source, chunks: chunks.length, action: "ingested", vectors: written, removed };
}

async function ingestKnowledge({ log = console.log } = {}) {
  const report = {
    files: [],
    errors: [],
    totalChunks: 0,
    totalVectors: 0,
    unchanged: 0,
  };

  const files = await discoverKnowledgeFiles();

  if (files.length === 0) {
    report.errors.push({
      source: "(none)",
      error: `No knowledge .md files found in: ${KNOWLEDGE_DIRS.join(", ")}`,
    });
    return report;
  }

  log(`Found ${files.length} knowledge file(s)`);

  for (const file of files) {
    try {
      const result = await ingestFile(file, log);
      report.files.push(result);
      report.totalChunks += result.chunks;
      report.totalVectors += result.vectors || 0;
      if (result.action === "unchanged") report.unchanged += 1;
    } catch (err) {
      log(`  ✗ ${file.source}: ${err.message}`);
      report.errors.push({ source: file.source, error: err.message });
    }
  }

  return report;
}

export { ingestKnowledge, discoverKnowledgeFiles, chunkIdFor, KNOWLEDGE_DIRS };
