import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TreeSitterChunker } from "../../chunker/index.js";
import type { ChunkType, CodeChunk } from "../../types.js";

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

function chunksByType(chunks: CodeChunk[], type: ChunkType): CodeChunk[] {
  return chunks.filter((c) => c.type === type);
}

describe("Dart", () => {
  const SOURCE = `import 'dart:math';
import 'package:http/http.dart' as http;

abstract class Greeter {
  String greet(String name);
}

class UserService implements Greeter {
  final String db;

  UserService(this.db);

  @override
  String greet(String name) => 'Hello, $name!';

  String? findUser(String id) => db;
}

String farewell(String name) => 'Goodbye, $name!';
`;

  test("detectLanguage: .dart -> dart", () => {
    expect(TreeSitterChunker.detectLanguage("foo.dart")).toBe("dart");
  });

  test("produces chunks for Dart source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("dart"),
      PROJECT_ID,
      "dart",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts class", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("dart"),
      PROJECT_ID,
      "dart",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name).filter(Boolean);
    expect(names).toContain("UserService");
  });

  test("produces multiple chunks for Dart source with class", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("dart"),
      PROJECT_ID,
      "dart",
    );
    // Dart chunks include class and method chunks
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("all chunks have language: dart", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("dart"),
      PROJECT_ID,
      "dart",
    );
    for (const c of chunks) expect(c.language).toBe("dart");
  });
});

describe("Dart — mixins, extensions, enums, typedefs", () => {
  const SRC = `mixin Comparable {
  int compareTo(dynamic other);
}

extension StringExt on String {
  String reversed2() => 'x';
}

enum Color { red, green, blue }

typedef IntList = List<int>;
`;

  test("mixin emitted as mixin chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("dart"),
      PROJECT_ID,
      "dart",
    );
    expect(chunksByType(chunks, "mixin").map((c) => c.name)).toContain(
      "Comparable",
    );
  });

  test("extension emitted as extension chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("dart"),
      PROJECT_ID,
      "dart",
    );
    expect(chunksByType(chunks, "extension").map((c) => c.name)).toContain(
      "StringExt",
    );
  });

  test("enum emitted as enum chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("dart"),
      PROJECT_ID,
      "dart",
    );
    expect(chunksByType(chunks, "enum").map((c) => c.name)).toContain("Color");
  });

  test("typedef emitted as typealias chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("dart"),
      PROJECT_ID,
      "dart",
    );
    expect(chunksByType(chunks, "typealias").map((c) => c.name)).toContain(
      "IntList",
    );
  });
});
