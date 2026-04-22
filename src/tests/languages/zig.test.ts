import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TreeSitterChunker } from "../../chunker/index.js";
import type { ChunkType, CodeChunk } from "../../types.js";

const PROJECT_ID = "test-lang";
const FILE = (ext: string) => `test/src/sample.${ext}`;

function chunksByType(chunks: CodeChunk[], type: ChunkType): CodeChunk[] {
  return chunks.filter((c) => c.type === type);
}

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

describe("Zig — structs, enums, tests", () => {
  const SRC = `const std = @import("std");

const Point = struct {
    x: i32,
    y: i32,
};

const Color = enum { red, green, blue };

fn add(a: i32, b: i32) i32 {
    return a + b;
}

test "basic add" {
    _ = add(1, 2);
}
`;

  test("struct emitted as struct chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("zig"),
      PROJECT_ID,
      "zig",
    );
    expect(chunksByType(chunks, "struct").map((c) => c.name)).toContain(
      "Point",
    );
  });

  test("enum emitted as enum chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("zig"),
      PROJECT_ID,
      "zig",
    );
    expect(chunksByType(chunks, "enum").map((c) => c.name)).toContain("Color");
  });

  test("test block emitted as test chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("zig"),
      PROJECT_ID,
      "zig",
    );
    expect(chunksByType(chunks, "test").map((c) => c.name)).toContain(
      "basic add",
    );
  });
});
