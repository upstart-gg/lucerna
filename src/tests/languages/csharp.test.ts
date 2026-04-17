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

function chunkByName(chunks: CodeChunk[], name: string): CodeChunk | undefined {
  return chunks.find((c) => c.name === name);
}

describe("C#", () => {
  const CS_SOURCE = `using System;
using System.Collections.Generic;

public interface IGreeter {
    string Greet(string name);
}

public record Person(string Name, int Age);

public struct Point {
    public int X { get; set; }
    public int Y { get; set; }
}

public enum Status {
    Active,
    Inactive,
    Banned
}

public class UserService : IGreeter {
    private readonly string _db;

    public UserService(string db) {
        _db = db;
    }

    public string Greet(string name) => $"Hello, {name}!";

    public string FindUser(string id) => _db;
}
`;

  test("detectLanguage: .cs -> csharp", () => {
    expect(TreeSitterChunker.detectLanguage("foo.cs")).toBe("csharp");
  });

  test("emits import chunk for using directives", async () => {
    const chunks = await chunker.chunkSource(
      CS_SOURCE,
      FILE("cs"),
      PROJECT_ID,
      "csharp",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("System");
  });

  test("extracts interface", async () => {
    const chunks = await chunker.chunkSource(
      CS_SOURCE,
      FILE("cs"),
      PROJECT_ID,
      "csharp",
    );
    const ifaces = chunksByType(chunks, "interface");
    expect(ifaces.length).toBeGreaterThan(0);
    expect(ifaces[0]?.name).toBe("IGreeter");
  });

  test("extracts class", async () => {
    const chunks = await chunker.chunkSource(
      CS_SOURCE,
      FILE("cs"),
      PROJECT_ID,
      "csharp",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name);
    expect(names).toContain("UserService");
  });

  test("extracts record as class type", async () => {
    const chunks = await chunker.chunkSource(
      CS_SOURCE,
      FILE("cs"),
      PROJECT_ID,
      "csharp",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name);
    expect(names).toContain("Person");
  });

  test("extracts struct as class type", async () => {
    const chunks = await chunker.chunkSource(
      CS_SOURCE,
      FILE("cs"),
      PROJECT_ID,
      "csharp",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name);
    expect(names).toContain("Point");
  });

  test("extracts enum as type", async () => {
    const chunks = await chunker.chunkSource(
      CS_SOURCE,
      FILE("cs"),
      PROJECT_ID,
      "csharp",
    );
    const types = chunksByType(chunks, "type");
    const names = types.map((c) => c.name);
    expect(names).toContain("Status");
  });

  test("extracts methods", async () => {
    const chunks = await chunker.chunkSource(
      CS_SOURCE,
      FILE("cs"),
      PROJECT_ID,
      "csharp",
    );
    const methods = chunksByType(chunks, "method");
    const names = methods.map((c) => c.name);
    expect(names).toContain("Greet");
    expect(names).toContain("FindUser");
  });

  test("method inside class has metadata.className set", async () => {
    const chunks = await chunker.chunkSource(
      CS_SOURCE,
      FILE("cs"),
      PROJECT_ID,
      "csharp",
    );
    const findUser = chunkByName(chunks, "FindUser");
    expect(findUser).toBeDefined();
    expect(findUser?.metadata?.className).toBe("UserService");
  });

  test("all chunks have language: csharp", async () => {
    const chunks = await chunker.chunkSource(
      CS_SOURCE,
      FILE("cs"),
      PROJECT_ID,
      "csharp",
    );
    for (const c of chunks) expect(c.language).toBe("csharp");
  });
});

describe("Graph edges — C# EXTENDS", () => {
  const SOURCE = `using System;

public interface IGreeter {}
public class BaseService {}

public class UserService : BaseService, IGreeter {
    public string Find(string id) => id;
}
`;

  test("emits EXTENDS edges for all entries in base_list", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("cs"),
      PROJECT_ID,
      "csharp",
    );
    const ext = rawEdges.filter((e) => e.type === "EXTENDS");
    const targets = ext.map((e) => e.targetSymbol);
    expect(targets).toContain("BaseService");
    expect(targets).toContain("IGreeter");
  });
});
