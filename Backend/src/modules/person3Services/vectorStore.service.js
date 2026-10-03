import { KnowledgeChunk } from "../assistant/knowledgeChunk.model.js";

class VectorStoreError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "VectorStoreError";
    this.code = code;
    this.status = status;
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return -1;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function upsertChunks(chunks) {
  if (!chunks.length) return 0;

  const operations = chunks.map((chunk) => ({
    updateOne: {
      filter: { _id: chunk.id },
      update: {
        $set: {
          source: chunk.source,
          knowledgeType: chunk.knowledgeType,
          topic: chunk.topic,
          section: chunk.section,
          subsection: chunk.subsection,
          chunkIndex: chunk.chunkIndex,
          docHash: chunk.docHash,
          content: chunk.content,
          vector: chunk.vector,
          embeddingModel: chunk.embeddingModel,
        },
      },
      upsert: true,
    },
  }));

  const result = await KnowledgeChunk.bulkWrite(operations, { ordered: false });

  const validationErrors = result?.mongoose?.validationErrors || [];
  if (validationErrors.length > 0) {
    throw new VectorStoreError(
      "VECTOR_STORE_ERROR",
      `Failed to store ${validationErrors.length} chunk(s): ${validationErrors[0].message}`,
      500
    );
  }

  return result.upsertedCount + result.modifiedCount;
}

async function removeStaleChunks(source, keepIds) {
  const keep = new Set(keepIds.map(String));
  const existing = await KnowledgeChunk.find({ source }, { _id: 1 }).lean();
  const stale = existing.map((doc) => doc._id).filter((id) => !keep.has(String(id)));

  if (stale.length === 0) return 0;

  const result = await KnowledgeChunk.deleteMany({ _id: { $in: stale } });
  return result.deletedCount;
}

async function getChunksBySource(source) {
  return KnowledgeChunk.find(source ? { source } : {})
    .select({ _id: 1, source: 1, docHash: 1, chunkIndex: 1, content: 1 })
    .lean();
}

async function countChunks() {
  return KnowledgeChunk.countDocuments();
}

async function countChunksBySource() {
  const rows = await KnowledgeChunk.aggregate([
    { $group: { _id: "$source", chunks: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((row) => ({ source: row._id, chunks: row.chunks }));
}

async function search(queryVector, { topK = 6, knowledgeTypes } = {}) {
  const filter = {};
  if (Array.isArray(knowledgeTypes) && knowledgeTypes.length > 0) {
    filter.knowledgeType = { $in: knowledgeTypes };
  }

  let docs;
  try {
    docs = await KnowledgeChunk.find(filter)
      .select({
        _id: 1,
        source: 1,
        knowledgeType: 1,
        topic: 1,
        section: 1,
        subsection: 1,
        chunkIndex: 1,
        content: 1,
        vector: 1,
      })
      .lean();
  } catch (err) {
    throw new VectorStoreError(
      "VECTOR_STORE_ERROR",
      `Vector search failed: ${err.message}`,
      500
    );
  }

  const scored = docs.map((doc) => ({
    id: doc._id,
    score: cosineSimilarity(queryVector, doc.vector),
    source: doc.source,
    knowledgeType: doc.knowledgeType,
    topic: doc.topic,
    section: doc.section,
    subsection: doc.subsection,
    chunkIndex: doc.chunkIndex,
    content: doc.content,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, topK));
}

export {
  VectorStoreError,
  cosineSimilarity,
  upsertChunks,
  removeStaleChunks,
  getChunksBySource,
  countChunks,
  countChunksBySource,
  search,
};
