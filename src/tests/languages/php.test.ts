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

describe("PHP", () => {
  const PHP_SOURCE = `<?php

use App\\Models\\User;
use App\\Services\\BaseService;

function greet(string $name): string {
    return "Hello, $name!";
}

function farewell(string $name): string {
    return "Goodbye, $name!";
}

interface Authenticator {
    public function authenticate(string $token): bool;
}

trait Loggable {
    public function log(string $msg): void {
        echo $msg;
    }
}

class UserService {
    private $db;

    public function __construct($db) {
        $this->db = $db;
    }

    public function findUser(string $id) {
        return $this->db->find($id);
    }

    public function deleteUser(string $id): void {
        $this->db->delete($id);
    }
}
`;

  test("detectLanguage: .php -> php", () => {
    expect(TreeSitterChunker.detectLanguage("foo.php")).toBe("php");
  });

  test("extracts top-level functions", async () => {
    const chunks = await chunker.chunkSource(
      PHP_SOURCE,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
    expect(names).toContain("farewell");
  });

  test("extracts class with name", async () => {
    const chunks = await chunker.chunkSource(
      PHP_SOURCE,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const cls = chunksByType(chunks, "class");
    expect(cls.length).toBeGreaterThan(0);
    expect(cls[0]?.name).toBe("UserService");
  });

  test("extracts interface with name", async () => {
    const chunks = await chunker.chunkSource(
      PHP_SOURCE,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const ifaces = chunksByType(chunks, "interface");
    const names = ifaces.map((c) => c.name);
    expect(names).toContain("Authenticator");
  });

  test("trait emitted as trait chunk", async () => {
    const chunks = await chunker.chunkSource(
      PHP_SOURCE,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const traits = chunksByType(chunks, "trait");
    const names = traits.map((c) => c.name);
    expect(names).toContain("Loggable");
  });

  test("extracts class methods as method type", async () => {
    const chunks = await chunker.chunkSource(
      PHP_SOURCE,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const methods = chunksByType(chunks, "method");
    const names = methods.map((c) => c.name);
    expect(names).toContain("findUser");
    expect(names).toContain("deleteUser");
  });

  test("method inside class has metadata.className set", async () => {
    const chunks = await chunker.chunkSource(
      PHP_SOURCE,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const findUser = chunkByName(chunks, "findUser");
    expect(findUser).toBeDefined();
    expect(findUser?.metadata?.className).toBe("UserService");
  });

  test("emits import chunk for use declarations", async () => {
    const chunks = await chunker.chunkSource(
      PHP_SOURCE,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("App");
  });

  test("all chunks have language: php", async () => {
    const chunks = await chunker.chunkSource(
      PHP_SOURCE,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    for (const c of chunks) expect(c.language).toBe("php");
  });
});

describe("Graph edges — PHP EXTENDS + IMPLEMENTS", () => {
  const SOURCE = `<?php

interface Loggable {}

class BaseService {}

class UserService extends BaseService implements Loggable {
    public function find(string $id): string {
        return $id;
    }
}
`;

  test("emits EXTENDS edge for class extends Base", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const ext = rawEdges.filter((e) => e.type === "EXTENDS");
    expect(ext.length).toBeGreaterThan(0);
    expect(ext[0]?.targetSymbol).toBe("BaseService");
  });

  test("emits IMPLEMENTS edge for class implements Interface", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const impl = rawEdges.filter((e) => e.type === "IMPLEMENTS");
    expect(impl.length).toBeGreaterThan(0);
    expect(impl[0]?.targetSymbol).toBe("Loggable");
  });
});

describe("PHP — enums, consts, properties (PHP 8+)", () => {
  const SRC = `<?php

enum Status: string {
    case Active = 'active';
    case Inactive = 'inactive';
}

class User {
    const VERSION = 'A long enough constant value to pass the min char filter';
    public string $name;
    public int $age;
}
`;

  test("enum emitted as enum chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const names = chunksByType(chunks, "enum").map((c) => c.name);
    expect(names).toContain("Status");
  });

  test("class const emitted as const chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const names = chunksByType(chunks, "const").map((c) => c.name);
    expect(names).toContain("VERSION");
  });

  test("class properties emitted as property chunks", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("php"),
      PROJECT_ID,
      "php",
    );
    const names = chunksByType(chunks, "property").map((c) => c.name);
    expect(names).toContain("name");
    expect(names).toContain("age");
  });
});
