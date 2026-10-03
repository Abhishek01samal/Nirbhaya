import {
  CHAT_PROMPT_TOKEN_LIMIT,
  CHAT_SUMMARY_MAX_TOKENS,
  CHAT_RECENT_MESSAGE_TOKEN_LIMIT,
} from "../../config/env.js";
import { estimateTokens } from "./jinaEmbedding.service.js";

const CHARS_PER_TOKEN = 4;
const SUMMARY_BUDGET_SHARE = 0.15;
const KNOWLEDGE_BUDGET_SHARE = 0.45;

function clampText(text, maxTokens) {
  const value = String(text || "");
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}...`;
}

function formatKnowledge(chunk) {
  const location = [chunk.topic, chunk.section, chunk.subsection]
    .filter(Boolean)
    .join(" > ");
  const header = `[${chunk.knowledgeType === "PROJECT" ? "APPLICATION" : "SAFETY"} KNOWLEDGE | ${chunk.source}${location ? ` | ${location}` : ""}]`;
  return `${header}\n${chunk.content}`;
}

function build({ sessionSummary, recentMessages = [], retrievedKnowledge = [], currentMessage }) {
  const budget = Math.max(1000, CHAT_PROMPT_TOKEN_LIMIT);

  const summaryCap = Math.min(CHAT_SUMMARY_MAX_TOKENS, Math.floor(budget * SUMMARY_BUDGET_SHARE));
  const knowledgeCap = Math.floor(budget * KNOWLEDGE_BUDGET_SHARE);
  const historyCap = Math.min(
    CHAT_RECENT_MESSAGE_TOKEN_LIMIT,
    budget - summaryCap - knowledgeCap
  );

  const summary = sessionSummary
    ? clampText(sessionSummary, summaryCap)
    : "(no summary yet for this session)";

  const projectKnowledge = [];
  const safetyKnowledge = [];
  let knowledgeTokens = 0;

  for (const chunk of retrievedKnowledge) {
    const text = formatKnowledge(chunk);
    const tokens = estimateTokens(text);
    if (knowledgeTokens + tokens > knowledgeCap) continue;
    knowledgeTokens += tokens;
    (chunk.knowledgeType === "PROJECT" ? projectKnowledge : safetyKnowledge).push(text);
  }

  const recent = [];
  let recentTokens = 0;

  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const message = recentMessages[i];
    const line = `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`;
    const tokens = estimateTokens(line);
    if (recentTokens + tokens > historyCap && recent.length > 0) break;
    recentTokens += tokens;
    recent.unshift(line);
  }

  const sections = [];

  sections.push(`[SESSION SUMMARY]\n${summary}`);

  if (recent.length > 0) {
    sections.push(`[RECENT CONVERSATION]\n${recent.join("\n")}`);
  }

  if (projectKnowledge.length > 0) {
    sections.push(`[RETRIEVED APPLICATION KNOWLEDGE]\n${projectKnowledge.join("\n\n")}`);
  }

  if (safetyKnowledge.length > 0) {
    sections.push(`[RETRIEVED SAFETY KNOWLEDGE]\n${safetyKnowledge.join("\n\n")}`);
  } else if (projectKnowledge.length === 0) {
    sections.push(
      "[RETRIEVED KNOWLEDGE]\n(no relevant knowledge was retrieved for this message — say so if the topic is not covered)"
    );
  }

  sections.push(`[CURRENT USER MESSAGE]\n${String(currentMessage || "").trim()}`);

  const prompt = sections.join("\n\n");

  return {
    prompt,
    stats: {
      promptTokens: estimateTokens(prompt),
      summaryTokens: estimateTokens(summary),
      recentMessages: recent.length,
      recentTokens,
      knowledgeChunks: projectKnowledge.length + safetyKnowledge.length,
      knowledgeTokens,
      budget,
    },
  };
}

export { build, formatKnowledge };
export default { build, formatKnowledge };
