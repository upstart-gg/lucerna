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

  test("extracts struct and class as class type with names", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name).filter(Boolean);
    expect(names).toContain("UserService");
    expect(names).toContain("AuthService");
  });

  test("extracts protocol as interface type", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const ifaces = chunksByType(chunks, "interface");
    const names = ifaces.map((c) => c.name);
    expect(names).toContain("Authenticatable");
  });

  test("extracts enum as type", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const types = chunksByType(chunks, "type");
    const names = types.map((c) => c.name);
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
