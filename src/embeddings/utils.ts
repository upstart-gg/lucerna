/**
 * Split `texts` into batches that stay within `maxCharsPerBatch` total characters
 * and `maxItemsPerBatch` items. All texts must already be ≤ maxCharsPerBatch chars.
 */
export function* charBudgetBatches(
  texts: string[],
  maxCharsPerBatch: number,
  maxItemsPerBatch: number,
): Generator<string[]> {
  let batch: string[] = [];
  let batchChars = 0;

  for (const text of texts) {
    const exceedsCharBudget =
      batch.length > 0 && batchChars + text.length > maxCharsPerBatch;
    const exceedsItemLimit = batch.length >= maxItemsPerBatch;
    if (exceedsCharBudget || exceedsItemLimit) {
      yield batch;
      batch = [];
      batchChars = 0;
    }
    batch.push(text);
    batchChars += text.length;
  }

  if (batch.length > 0) yield batch;
}

/**
 * Normalize a vector to unit L2 length. Required by some embedding APIs
 * (e.g. Gemini) when the returned vector uses fewer than the native dimensions,
 * since the API only normalizes at the native dim. A zero vector is returned
 * unchanged.
 */
export function l2Normalize(v: number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  if (sumSq === 0) return v;
  const norm = Math.sqrt(sumSq);
  return v.map((x) => x / norm);
}

/** Component-wise mean of a list of equal-length vectors. */
export function averageVectors(vecs: number[][]): number[] {
  const dim = vecs[0]?.length ?? 0;
  const sum = new Array<number>(dim).fill(0);
  for (const vec of vecs) {
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] ?? 0) + (vec[i] ?? 0);
  }
  return sum.map((v) => v / vecs.length);
}

/** Split `text` into chunks of at most `maxChars` characters. */
export function splitTextToChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}

/**
 * Truncate `text` to at most `maxChars` characters using a head + tail strategy
 * that preserves both the beginning and end of the text, inserting `/* … *\/` in
 * the middle. Returns the text unchanged if it already fits.
 */
export function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const MARKER = "/* … */";
  const available = maxChars - MARKER.length;
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return `${text.slice(0, head)}${MARKER}${text.slice(text.length - tail)}`;
}

/**
 * Given a list of source texts and a flat array of piece embeddings (where
 * each source text was split into one or more pieces tracked by `ranges`),
 * reassemble the final embedding per source text by averaging piece vectors.
 */
export function reassembleVectors(
  pieceVectors: number[][],
  ranges: [number, number][],
): number[][] {
  return ranges.map(([start, end]) => {
    if (end - start === 1) return pieceVectors[start] ?? [];
    return averageVectors(pieceVectors.slice(start, end));
  });
}

/**
 * Split all texts into pieces (chunking oversized ones), track the ranges of
 * pieces that belong to each original text, and return char-budget batches.
 *
 * Usage:
 *   const { pieces, ranges } = prepareTexts(texts, MAX_PER_TEXT_CHARS);
 *   for (const batch of charBudgetBatches(pieces, MAX_BATCH_CHARS, MAX_BATCH_ITEMS)) {
 *     ...embed batch...
 *   }
 *   return reassembleVectors(allPieceVectors, ranges);
 */
export function prepareTexts(
  texts: string[],
  maxPerTextChars: number,
): { pieces: string[]; ranges: [number, number][] } {
  const pieces: string[] = [];
  const ranges: [number, number][] = [];
  for (const text of texts) {
    const start = pieces.length;
    for (const chunk of splitTextToChunks(text, maxPerTextChars)) {
      pieces.push(chunk);
    }
    ranges.push([start, pieces.length]);
  }
  return { pieces, ranges };
}
