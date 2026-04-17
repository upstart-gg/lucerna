import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TreeSitterChunker } from "../../chunker/index.js";

const PROJECT_ID = "test-lang";
const FILE = (ext: string) => `test/src/sample.${ext}`;

let chunker: TreeSitterChunker;

beforeAll(async () => {
  chunker = new TreeSitterChunker({});
  await chunker.initialize();
});

afterAll(async () => {
  await chunker.close();
});

describe("Zig", () => {
  const SOURCE = `const std = @import("std");

pub fn greet(name: []const u8) void {
    std.debug.print("Hello, {s}!\\n", .{name});
}

pub fn add(a: i32, b: i32) i32 {
    return a + b;
}

pub fn farewell(name: []const u8) void {
    std.debug.print("Goodbye, {s}!\\n", .{name});
}
`;

  test("detectLanguage: .zig -> zig", () => {
    expect(TreeSitterChunker.detectLanguage("foo.zig")).toBe("zig");
  });

  test("produces chunks for Zig source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("zig"),
      PROJECT_ID,
      "zig",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("chunk content contains function source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("zig"),
      PROJECT_ID,
      "zig",
    );
    // Zig falls back to a whole-file chunk
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("greet");
    expect(allContent).toContain("add");
  });

  test("all chunks have language: zig", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("zig"),
      PROJECT_ID,
      "zig",
    );
    for (const c of chunks) expect(c.language).toBe("zig");
  });
});
