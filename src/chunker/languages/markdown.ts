import type { CodeChunk } from "../../types.js";

function makeFileChunk(
  source: string,
  filePath: string,
  projectId: string,
): CodeChunk {
  const lines = source.split("\n");
  return {
    id: "",
    projectId,
    filePath,
    language: "markdown",
    type: "file",
    content: source,
    contextContent: source,
    startLine: 1,
    endLine: lines.length,
    metadata: {},
  };
}

/**
 * Extracts chunks from Markdown files.
 *
 * Strategy: split at H1/H2/H3 headings. Each section chunk carries the
 * full heading hierarchy as context prefix. Large sections are further split
 * at paragraph boundaries to stay within `maxChunkChars`.
 */
export function extractMarkdown(
  source: string,
  filePath: string,
  projectId: string,
  maxChunkChars: number,
): CodeChunk[] {
  return extractWithRegex(source, filePath, projectId, maxChunkChars);
}

// ---------------------------------------------------------------------------
// Regex-based extraction
// ---------------------------------------------------------------------------

function extractWithRegex(
  source: string,
  filePath: string,
  projectId: string,
  maxChunkChars: number,
): CodeChunk[] {
  const lines = source.split("\n");
  const headingPattern = /^(#{1,3})\s+(.+)/;

  const boundaries: { line: number; level: number; heading: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]?.match(headingPattern);
    if (match) {
      boundaries.push({
        line: i + 1,
        // biome-ignore lint/style/noNonNullAssertion: match[1] is guaranteed to exist due to the regex pattern
        level: match[1]!.length,
        // biome-ignore lint/style/noNonNullAssertion: match[2] is guaranteed to exist due to the regex pattern
        heading: match[2]!.trim(),
      });
    }
  }

  if (boundaries.length === 0) {
    return [makeFileChunk(source, filePath, projectId)];
  }

  const chunks: CodeChunk[] = [];
  const headingStack: string[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    if (!boundary) continue;
    const { line, level, heading } = boundary;
    const nextLine = boundaries[i + 1]?.line ?? lines.length + 1;

    while (headingStack.length >= level) headingStack.pop();
    headingStack.push(heading);

    const content = lines
      .slice(line - 1, nextLine - 1)
      .join("\n")
      .trim();
    const breadcrumb = headingStack.join(" > ");

    if (content) {
      const contextContent = `${breadcrumb}\n\n${content}`;
      if (contextContent.length > maxChunkChars) {
        chunks.push(
          ...splitLargeSection(
            content,
            contextContent,
            filePath,
            projectId,
            line,
            maxChunkChars,
          ),
        );
      } else {
        chunks.push({
          id: "",
          projectId,
          filePath,
          language: "markdown",
          type: "section",
          name: heading,
          content,
          contextContent,
          startLine: line,
          endLine: nextLine - 1,
          metadata: { level, breadcrumb },
        });
      }
    }
  }

  return chunks.length > 0
    ? chunks
    : [makeFileChunk(source, filePath, projectId)];
}

// ---------------------------------------------------------------------------
// Large section splitting
// ---------------------------------------------------------------------------

function splitLargeSection(
  content: string,
  contextContent: string,
  filePath: string,
  projectId: string,
  startLineNum: number,
  maxChunkChars: number,
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const paragraphs = content.split(/\n{2,}/);
  let buffer = "";
  let bufferStartLine = startLineNum;
  let currentLine = startLineNum;

  for (const para of paragraphs) {
    const paraLines = para.split("\n").length;
    if (buffer.length + para.length > maxChunkChars && buffer.length > 0) {
      chunks.push({
        id: "",
        projectId,
        filePath,
        language: "markdown",
        type: "section",

        content: buffer.trim(),
        contextContent: `${contextContent}\n\n${buffer.trim()}`,
        startLine: bufferStartLine,
        endLine: currentLine,
        metadata: {},
      });
      buffer = para;
      bufferStartLine = currentLine + 1;
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }
    currentLine += paraLines + 1;
  }

  if (buffer.trim()) {
    chunks.push({
      id: "",
      projectId,
      filePath,
      language: "markdown",
      type: "section",
      content: buffer.trim(),
      contextContent: `${contextContent}\n\n${buffer.trim()}`,
      startLine: bufferStartLine,
      endLine: currentLine,
      metadata: {},
    });
  }

  return chunks;
}
