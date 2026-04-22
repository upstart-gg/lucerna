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

describe("Kotlin", () => {
  const KT_SOURCE = `import kotlin.collections.List
import kotlin.String

package com.example

class UserService(private val db: String) {
    fun findUser(id: String): String? = db

    fun deleteUser(id: String) {
        println("deleted $id")
    }
}

data class User(val id: String, val name: String)

interface Repository {
    fun findAll(): List<String>
}

fun greet(name: String): String = "Hello, $name!"
`;

  test("detectLanguage: .kt -> kotlin", () => {
    expect(TreeSitterChunker.detectLanguage("foo.kt")).toBe("kotlin");
  });

  test("detectLanguage: .kts -> kotlin", () => {
    expect(TreeSitterChunker.detectLanguage("foo.kts")).toBe("kotlin");
  });

  test("extracts class with name", async () => {
    const chunks = await chunker.chunkSource(
      KT_SOURCE,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name).filter(Boolean);
    expect(names).toContain("UserService");
  });

  test("extracts top-level function with name", async () => {
    const chunks = await chunker.chunkSource(
      KT_SOURCE,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name).filter(Boolean);
    expect(names).toContain("greet");
  });

  test("emits import chunk for import headers", async () => {
    const chunks = await chunker.chunkSource(
      KT_SOURCE,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("kotlin");
  });

  test("all chunks have language: kotlin", async () => {
    const chunks = await chunker.chunkSource(
      KT_SOURCE,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    for (const c of chunks) expect(c.language).toBe("kotlin");
  });
});

describe("Kotlin — objects, enums, interfaces, typealiases", () => {
  const SRC = `package com.example

object Settings {
    val maxRetries = 5
}

enum class Color { RED, GREEN, BLUE }

interface Repository {
    fun findAll(): List<String>
}

typealias UserId = String
`;

  test("object emitted as object chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    expect(chunksByType(chunks, "object").map((c) => c.name)).toContain(
      "Settings",
    );
  });

  test("enum class emitted as enum chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    expect(chunksByType(chunks, "enum").map((c) => c.name)).toContain("Color");
  });

  test("interface emitted as interface chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    expect(chunksByType(chunks, "interface").map((c) => c.name)).toContain(
      "Repository",
    );
  });

  test("typealias emitted as typealias chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    expect(chunksByType(chunks, "typealias").map((c) => c.name)).toContain(
      "UserId",
    );
  });
});

describe("Graph edges — Kotlin EXTENDS + IMPLEMENTS", () => {
  const SOURCE = `interface Greetable {}
open class BaseService {}

class UserService(val db: String) : BaseService(), Greetable {
    fun find(id: String) = id
}
`;

  test("emits EXTENDS edge for class constructor invocation", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    const ext = rawEdges.filter((e) => e.type === "EXTENDS");
    expect(ext.length).toBeGreaterThan(0);
    expect(ext[0]?.targetSymbol).toBe("BaseService");
  });

  test("emits IMPLEMENTS edge for interface delegation", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    const impl = rawEdges.filter((e) => e.type === "IMPLEMENTS");
    expect(impl.length).toBeGreaterThan(0);
    expect(impl[0]?.targetSymbol).toBe("Greetable");
  });
});
