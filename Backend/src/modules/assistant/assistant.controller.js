import { ChatSession } from "./chatSession.model.js";
import { ChatMessage } from "./chatMessage.model.js";
import { isDbConnected } from "../../config/db.js";
import { embedQuery, EmbeddingError, estimateTokens } from "../person3Services/jinaEmbedding.service.js";
import { search } from "../person3Services/vectorStore.service.js";
import { build as buildContext } from "../person3Services/contextBuilder.service.js";
import {
  generateChatReply,
  summarizeConversation,
  ChatAIError,
} from "../person3Services/geminiChat.service.js";
import { detectLanguage } from "../person3Services/geminiTranslate.service.js";
import {
  RAG_TOP_K,
  CHAT_RECENT_MESSAGE_TOKEN_LIMIT,
  CHAT_SUMMARY_TRIGGER_TOKEN_LIMIT,
  CHAT_MAX_MESSAGE_CHARS,
} from "../../config/env.js";

const MAX_SESSION_ID_CHARS = 128;

function badRequest(res, code, message) {
  return res.status(400).json({ success: false, error: { code, message } });
}

function serverError(res, code, message, status = 500) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function splitRecentAndOlder(allMessages, recentTokenLimit) {
  const history = allMessages.slice(0, -1);

  let total = 0;
  let index = history.length - 1;

  for (; index >= 0; index--) {
    const tokens = estimateTokens(history[index].content);
    if (total + tokens > recentTokenLimit && total > 0) break;
    total += tokens;
  }

  return {
    recent: history.slice(index + 1),
    older: history.slice(0, index + 1),
  };
}

async function maybeUpdateSummary(session, olderMessages) {
  const covered = session.summaryCoveredCount || 0;
  const uncovered = olderMessages.slice(covered);

  if (uncovered.length === 0) return session.summary;

  const uncoveredTokens = uncovered.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0
  );

  if (uncoveredTokens < CHAT_SUMMARY_TRIGGER_TOKEN_LIMIT) return session.summary;

  const summary = await summarizeConversation({
    existingSummary: session.summary,
    messages: uncovered,
  });

  session.summary = summary;
  session.summaryCoveredCount = covered + uncovered.length;
  await session.save();

  return session.summary;
}

async function loadOrCreateSession(sessionId) {
  let session = await ChatSession.findOne({ sessionId });
  if (session) return session;

  try {
    return await ChatSession.create({ sessionId, summary: "", summaryCoveredCount: 0 });
  } catch (err) {
    if (err && err.code === 11000) return ChatSession.findOne({ sessionId });
    throw err;
  }
}

export async function chat(req, res) {
  const { sessionId, message } = req.body ?? {};

  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return badRequest(res, "VALIDATION_ERROR", "sessionId is required");
  }
  if (sessionId.trim().length > MAX_SESSION_ID_CHARS) {
    return badRequest(
      res,
      "VALIDATION_ERROR",
      `sessionId must not exceed ${MAX_SESSION_ID_CHARS} characters`
    );
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    return badRequest(res, "VALIDATION_ERROR", "message is required");
  }
  if (message.length > CHAT_MAX_MESSAGE_CHARS) {
    return badRequest(
      res,
      "VALIDATION_ERROR",
      `message must not exceed ${CHAT_MAX_MESSAGE_CHARS} characters`
    );
  }

  if (!isDbConnected()) {
    return serverError(res, "DATABASE_UNAVAILABLE", "Database is not available");
  }

  const sid = sessionId.trim();
  const cleanMessage = message.trim();

  const languagePromise = detectLanguage(cleanMessage).catch((err) => {
    console.warn(`⚠️ language detection skipped (reply follows conversation language): ${err.message}`);
    return null;
  });

  const queryPromise = embedQuery(cleanMessage);
  queryPromise.catch(() => {});

  let session;
  try {
    session = await loadOrCreateSession(sid);
  } catch (err) {
    console.error("chat session load error:", err);
    return serverError(res, "DATABASE_ERROR", "Failed to load the chat session");
  }

  const detected = await languagePromise;

  let replyLanguage = "unknown";
  let replyLanguageName = "";
  let replyScript = "unknown";
  if (detected && detected.language && detected.language !== "unknown") {
    replyLanguage = detected.language;
    replyLanguageName = detected.languageName;
    replyScript = detected.script;
  } else if (session.language && session.language !== "unknown") {
    replyLanguage = session.language;
    replyLanguageName = "";
    replyScript =
      session.script && session.script !== "unknown"
        ? session.script
        : session.language === "hinglish" || session.language === "en"
          ? "latin"
          : "native";
  }

  if (replyLanguage !== "unknown" && (session.language !== replyLanguage || session.script !== replyScript)) {
    session.language = replyLanguage;
    session.script = replyScript;
    session.save().catch((err) => console.warn(`⚠️ failed to persist session language: ${err.message}`));
  }

  try {
    await ChatMessage.create({
      sessionId: sid,
      role: "user",
      content: cleanMessage,
      language: replyLanguage,
      script: replyScript,
    });
  } catch (err) {
    console.error("chat message store error:", err);
    return serverError(res, "DATABASE_ERROR", "Failed to store the message");
  }

  let allMessages;
  try {
    allMessages = await ChatMessage.find({ sessionId: sid })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
  } catch (err) {
    console.error("chat message load error:", err);
    return serverError(res, "DATABASE_ERROR", "Failed to load the conversation");
  }

  const { recent, older } = splitRecentAndOlder(allMessages, CHAT_RECENT_MESSAGE_TOKEN_LIMIT);

  let summary = session.summary || "";
  try {
    summary = await maybeUpdateSummary(session, older);
  } catch (err) {
    console.error("chat summary update failed (continuing without):", err.message);
  }

  let knowledge = [];
  try {
    const queryVector = await queryPromise;
    knowledge = await search(queryVector, { topK: RAG_TOP_K });
  } catch (err) {
    if (err instanceof EmbeddingError) {
      return serverError(res, err.code, err.message, err.status);
    }
    console.error("knowledge retrieval failed (continuing without):", err.message);
  }

  const { prompt, stats } = buildContext({
    sessionSummary: summary,
    recentMessages: recent,
    retrievedKnowledge: knowledge,
    currentMessage: cleanMessage,
  });

  console.log(
    `🧠 chat [${sid}] lang=${replyLanguage}/${replyScript} prompt=${stats.promptTokens}tok recent=${stats.recentMessages}msg knowledge=${stats.knowledgeChunks}chunks summary=${stats.summaryTokens}tok`
  );

  let reply;
  try {
    reply = await generateChatReply({
      prompt,
      language: replyLanguage,
      languageName: replyLanguageName,
      script: replyScript,
    });
  } catch (err) {
    if (err instanceof ChatAIError) {
      return serverError(res, err.code, err.message, err.status);
    }
    console.error("chat generation error:", err);
    return serverError(res, "INTERNAL_ERROR", "Unexpected server error");
  }

  try {
    await ChatMessage.create({
      sessionId: sid,
      role: "assistant",
      content: reply,
      language: replyLanguage,
      script: replyScript,
    });
  } catch (err) {
    console.error("assistant message store error (reply still returned):", err.message);
  }

  return res.status(200).json({
    success: true,
    data: {
      sessionId: sid,
      reply,
      replyLanguage,
      replyScript,
      knowledgeUsed: knowledge.length,
      contextTokens: stats.promptTokens,
    },
  });
}
