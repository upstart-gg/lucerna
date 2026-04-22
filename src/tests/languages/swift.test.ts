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

describe("Swift", () => {
  const SWIFT_SOURCE = `import Foundation
import UIKit

struct UserService {
    let db: String

    func findUser(id: String) -> String? {
        return db
    }

    func deleteUser(id: String) {
        _ = id
    }
}

class AuthService {
    func login(username: String) -> Bool {
        return username == "admin"
    }
}

protocol Authenticatable {
    func authenticate(token: String) -> Bool
}

enum Status {
    case active
    case inactive
}

func greet(name: String) -> String {
    return "Hello, \\(name)!"
}
`;

  test("detectLanguage: .swift -> swift", () => {
    expect(TreeSitterChunker.detectLanguage("foo.swift")).toBe("swift");
  });

  test("extracts struct as struct type", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const structs = chunksByType(chunks, "struct");
    const names = structs.map((c) => c.name).filter(Boolean);
    expect(names).toContain("UserService");
  });

  test("extracts class as class type", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name).filter(Boolean);
    expect(names).toContain("AuthService");
  });

  test("extracts protocol as protocol type", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const protocols = chunksByType(chunks, "protocol");
    const names = protocols.map((c) => c.name);
    expect(names).toContain("Authenticatable");
  });

  test("extracts enum as enum type", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const enums = chunksByType(chunks, "enum");
    const names = enums.map((c) => c.name);
    expect(names).toContain("Status");
  });

  test("extracts top-level function", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
  });

  test("emits import chunk for import declarations", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("Foundation");
  });

  test("all chunks have language: swift", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    for (const c of chunks) expect(c.language).toBe("swift");
  });
});

describe("Swift — actors, extensions, typealiases, properties", () => {
  const SRC = `actor Counter {
    var count = 0
}

extension String {
    func reversed2() -> String { return String(reversed()) }
}

typealias UserId = String
`;

  test("actor emitted as actor chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    expect(chunksByType(chunks, "actor").map((c) => c.name)).toContain(
      "Counter",
    );
  });

  test("extension emitted as extension chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    expect(chunksByType(chunks, "extension").map((c) => c.name)).toContain(
      "String",
    );
  });

  test("typealias emitted as typealias chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    expect(chunksByType(chunks, "typealias").map((c) => c.name)).toContain(
      "UserId",
    );
  });
});

describe("Graph edges — Swift EXTENDS", () => {
  const SOURCE = `protocol Greetable {}
class BaseService {}

class UserService: BaseService, Greetable {
    func find(id: String) -> String { return id }
}
`;

  test("emits EXTENDS edges for parent class and protocol conformances", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const ext = rawEdges.filter((e) => e.type === "EXTENDS");
    const targets = ext.map((e) => e.targetSymbol);
    expect(targets).toContain("BaseService");
    expect(targets).toContain("Greetable");
  });
});
