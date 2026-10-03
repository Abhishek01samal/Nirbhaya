import mongoose from "mongoose";

const { Schema } = mongoose;

const KnowledgeChunkSchema = new Schema(
  {
    _id: { type: String },
    source: { type: String, required: true },
    knowledgeType: { type: String, enum: ["PROJECT", "SAFETY", "OTHER"], required: true },
    topic: { type: String, default: "" },
    section: { type: String, default: "" },
    subsection: { type: String, default: "" },
    chunkIndex: { type: Number, required: true },
    docHash: { type: String, required: true },
    content: { type: String, required: true },
    vector: { type: [Number], required: true },
    embeddingModel: { type: String, required: true },
  },
  {
    timestamps: true,
  }
);

KnowledgeChunkSchema.index({ source: 1, docHash: 1 });
KnowledgeChunkSchema.index({ knowledgeType: 1 });

const KnowledgeChunk =
  mongoose.models.KnowledgeChunk ||
  mongoose.model("KnowledgeChunk", KnowledgeChunkSchema);

export { KnowledgeChunk };
