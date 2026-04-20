import { describe, expect, test } from "bun:test";
import {
  averageVectors,
  charBudgetBatches,
  prepareTexts,
  reassembleVectors,
  splitTextToChunks,
  truncateWithEllipsis,
} from "../embeddings/utils.js";

describe("charBudgetBatches", () => {
  test("single text within budget → one batch", () => {
    const batches = [...charBudgetBatches(["hello"], 100, 10)];
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(["hello"]);
  });

  test("splits on item limit", () => {
    const texts = ["a", "b", "c", "d", "e"];
    const batches = [...charBudgetBatches(texts, 1000, 2)];
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual(["a", "b"]);
    expect(batches[1]).toEqual(["c", "d"]);
    expect(batches[2]).toEqual(["e"]);
  });

  test("splits on char budget", () => {
    const texts = ["aaa", "bbb", "ccc"]; // each 3 chars
    const batches = [...charBudgetBatches(texts, 5, 100)]; // budget=5, so max 1 per batch after first overflows
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual(["aaa"]);
    expect(batches[1]).toEqual(["bbb"]);
    expect(batches[2]).toEqual(["ccc"]);
  });

  test("packs multiple texts within char budget", () => {
    const texts = ["ab", "cd", "ef", "gh"]; // each 2 chars
    const batches = [...charBudgetBatches(texts, 4, 100)]; // budget=4, fits 2 per batch
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(["ab", "cd"]);
    expect(batches[1]).toEqual(["ef", "gh"]);
  });

  test("empty input → no batches", () => {
    const batches = [...charBudgetBatches([], 100, 10)];
    expect(batches).toHaveLength(0);
  });
});

describe("averageVectors", () => {
  test("single vector → returns it unchanged", () => {
    expect(averageVectors([[1, 2, 3]])).toEqual([1, 2, 3]);
  });

  test("two vectors averaged component-wise", () => {
    const result = averageVectors([
      [1, 3],
      [3, 1],
    ]);
    expect(result[0]).toBeCloseTo(2);
    expect(result[1]).toBeCloseTo(2);
  });

  test("three vectors averaged correctly", () => {
    const result = averageVectors([
      [0, 6],
      [3, 3],
      [6, 0],
    ]);
    expect(result[0]).toBeCloseTo(3);
    expect(result[1]).toBeCloseTo(3);
  });
});

describe("splitTextToChunks", () => {
  test("text within limit → single chunk", () => {
    expect(splitTextToChunks("hello", 10)).toEqual(["hello"]);
  });

  test("text exactly at limit → single chunk", () => {
    const text = "x".repeat(10);
    expect(splitTextToChunks(text, 10)).toEqual([text]);
  });

  test("text over limit → multiple chunks of maxChars", () => {
    const text = "x".repeat(25);
    const chunks = splitTextToChunks(text, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[1]).toHaveLength(10);
    expect(chunks[2]).toHaveLength(5);
  });

  test("reconstructed chunks equal original text", () => {
    const text = "abcdefghij".repeat(5);
    const chunks = splitTextToChunks(text, 7);
    expect(chunks.join("")).toBe(text);
  });
});

describe("truncateWithEllipsis", () => {
  test("text within limit → returned unchanged", () => {
    expect(truncateWithEllipsis("hello world", 100)).toBe("hello world");
  });

  test("text exactly at limit → returned unchanged", () => {
    const text = "x".repeat(20);
    expect(truncateWithEllipsis(text, 20)).toBe(text);
  });

  test("truncated text is exactly maxChars long", () => {
    const text = "x".repeat(1000);
    const result = truncateWithEllipsis(text, 100);
    expect(result).toHaveLength(100);
  });

  test("truncated text contains the ellipsis marker", () => {
    const text = "x".repeat(1000);
    const result = truncateWithEllipsis(text, 100);
    expect(result).toContain("/* … */");
  });

  test("preserves both head and tail content", () => {
    const text = `HEAD${"x".repeat(1000)}TAIL`;
    const result = truncateWithEllipsis(text, 50);
    expect(result.startsWith("HEAD")).toBe(true);
    expect(result.endsWith("TAIL")).toBe(true);
  });
});

describe("prepareTexts + reassembleVectors", () => {
  test("texts within limit → one piece each, ranges are 1-wide", () => {
    const texts = ["foo", "bar"];
    const { pieces, ranges } = prepareTexts(texts, 10);
    expect(pieces).toEqual(["foo", "bar"]);
    expect(ranges).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  test("oversized text → split into multiple pieces", () => {
    const text = "x".repeat(30);
    const { pieces, ranges } = prepareTexts([text], 10);
    expect(pieces).toHaveLength(3);
    expect(ranges).toEqual([[0, 3]]);
  });

  test("reassembleVectors: single piece per text → pass-through", () => {
    const pieceVectors = [
      [1, 2],
      [3, 4],
    ];
    const ranges: [number, number][] = [
      [0, 1],
      [1, 2],
    ];
    expect(reassembleVectors(pieceVectors, ranges)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("reassembleVectors: multi-piece text → averaged", () => {
    const pieceVectors = [
      [0, 4],
      [4, 0],
    ];
    const ranges: [number, number][] = [[0, 2]];
    const result = reassembleVectors(pieceVectors, ranges);
    expect(result).toHaveLength(1);
    expect(result[0]?.[0]).toBeCloseTo(2);
    expect(result[0]?.[1]).toBeCloseTo(2);
  });

  test("mixed: first text fits, second is split", () => {
    const texts = ["short", "x".repeat(30)];
    const { pieces, ranges } = prepareTexts(texts, 10);
    // "short" fits in one piece; "x".repeat(30) splits into 3
    expect(pieces).toHaveLength(4);
    expect(ranges[0]).toEqual([0, 1]);
    expect(ranges[1]).toEqual([1, 4]);

    const pieceVectors = pieces.map((_, i) => [i * 2]);
    const result = reassembleVectors(pieceVectors, ranges);
    expect(result).toHaveLength(2);
    // First text: piece 0 = [0], returned as-is
    expect(result[0]).toEqual([0]);
    // Second text: pieces 1,2,3 = [2],[4],[6], averaged = [4]
    expect(result[1]?.[0]).toBeCloseTo(4);
  });
});
