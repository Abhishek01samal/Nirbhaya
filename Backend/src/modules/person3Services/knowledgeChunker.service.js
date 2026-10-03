import { RAG_CHUNK_SIZE, RAG_CHUNK_OVERLAP } from "../../config/env.js";
import { estimateTokens } from "./jinaEmbedding.service.js";

const CHARS_PER_TOKEN = 4;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

function knowledgeTypeFor(fileName) {
  const name = String(fileName).toLowerCase();
  if (name.includes("project") || name.includes("about")) return "PROJECT";
  if (name.includes("safety")) return "SAFETY";
  return "OTHER";
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitOversizedUnit(text, maxTokens) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const pieces = [];

  for (const sentence of splitSentences(text)) {
    if (estimateTokens(sentence) <= maxTokens) {
      pieces.push(sentence);
      continue;
    }

    for (let i = 0; i < sentence.length; i += maxChars) {
      pieces.push(sentence.slice(i, i + maxChars));
    }
  }

  return pieces;
}

function parseSections(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const sections = [];
  const headingStack = [];
  let current = { headingPath: [], lines: [] };
  let inCodeFence = false;

  const flush = () => {
    if (current.lines.join("").trim().length > 0) sections.push(current);
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inCodeFence = !inCodeFence;
      current.lines.push(line);
      continue;
    }

    const heading = inCodeFence ? null : line.match(HEADING_PATTERN);

    if (heading) {
      flush();
      const level = heading[1].length;
      const text = heading[2].trim();

      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, text });

      current = { headingPath: headingStack.map((h) => ({ ...h })), lines: [] };
      continue;
    }

    current.lines.push(line);
  }

  flush();
  return sections;
}

function splitUnits(sectionLines) {
  const text = sectionLines.join("\n").trim();
  if (!text) return [];

  const blocks = text.split(/\n\s*\n/);
  const units = [];

  for (const block of blocks) {
    const cleaned = block
      .split("\n")
      .filter((line) => !/^\s*(-{3,}|\*{3,})\s*$/.test(line))
      .join("\n")
      .trim();

    if (cleaned) units.push(cleaned);
  }

  return units;
}

function rolesFor(headingPath) {
  const effective = headingPath.length > 1 ? headingPath.slice(1) : headingPath;
  return {
    topic: effective[0]?.text || "",
    section: effective[1]?.text || "",
    subsection: effective[2]?.text || "",
  };
}

function breadcrumbFor(roles) {
  return [roles.topic, roles.section, roles.subsection].filter(Boolean).join(" > ");
}

function tailOverlap(body, overlapTokens) {
  if (overlapTokens <= 0) return "";

  const maxChars = overlapTokens * CHARS_PER_TOKEN;
  if (body.length <= maxChars) return body.trim();

  const cut = body.length - maxChars;
  const rest = body.slice(cut);

  const boundaries = [];
  const paragraph = rest.indexOf("\n\n");
  if (paragraph >= 0) boundaries.push(paragraph + 2);
  const sentence = rest.search(/(?<=[.!?])\s/);
  if (sentence >= 0) boundaries.push(sentence + 1);
  const newline = rest.indexOf("\n");
  if (newline >= 0) boundaries.push(newline + 1);
  const space = rest.indexOf(" ");
  if (space >= 0) boundaries.push(space + 1);

  const first = boundaries.length > 0 ? Math.min(...boundaries) : rest.length;
  let tail = body.slice(cut + first).trim();

  if (tail.startsWith("## ")) {
    const nextBreak = tail.indexOf("\n\n");
    tail = nextBreak >= 0 ? tail.slice(nextBreak + 2).trim() : "";
  }

  return tail;
}

function chunkMarkdown(markdown, options = {}) {
  const {
    source,
    knowledgeType = "OTHER",
    chunkSize = RAG_CHUNK_SIZE,
    chunkOverlap = RAG_CHUNK_OVERLAP,
  } = options;

  const sections = parseSections(markdown);
  const chunks = [];

  let body = "";
  let bodyRoles = null;
  let overlapPrefix = "";

  const flushChunk = () => {
    const trimmed = body.trim();
    if (!trimmed || !bodyRoles) return;

    const breadcrumb = breadcrumbFor(bodyRoles);
    const content = breadcrumb ? `${breadcrumb}\n\n${trimmed}` : trimmed;

    chunks.push({
      source,
      knowledgeType,
      topic: bodyRoles.topic,
      section: bodyRoles.section,
      subsection: bodyRoles.subsection,
      chunkIndex: chunks.length,
      content,
      tokens: estimateTokens(content),
    });

    overlapPrefix = tailOverlap(trimmed, chunkOverlap);
    body = "";
    bodyRoles = null;
  };

  for (const section of sections) {
    const roles = rolesFor(section.headingPath);

    for (const unit of splitUnits(section.lines)) {
      const pieces =
        estimateTokens(unit) > chunkSize ? splitOversizedUnit(unit, chunkSize) : [unit];

      for (const piece of pieces) {
        const rolesDiffer = bodyRoles && breadcrumbFor(bodyRoles) !== breadcrumbFor(roles);
        const inlineLabel = rolesDiffer ? `## ${breadcrumbFor(roles)}\n\n` : "";
        const projected = estimateTokens(body) + estimateTokens(inlineLabel) + estimateTokens(piece);

        if (body.length > 0 && projected > chunkSize) flushChunk();

        if (body.length === 0) {
          const prefix = overlapPrefix ? `${overlapPrefix}\n\n` : "";
          bodyRoles = roles;
          body = `${prefix}${piece}`;
          overlapPrefix = "";
        } else if (rolesDiffer) {
          body = `${body}\n\n${inlineLabel}${piece}`;
        } else {
          body = `${body}\n\n${piece}`;
        }
      }
    }
  }

  flushChunk();
  return chunks;
}

export { chunkMarkdown, knowledgeTypeFor, parseSections };
