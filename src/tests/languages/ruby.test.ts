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

describe("Ruby", () => {
  const RB_SOURCE = `require 'activerecord'
require_relative 'base_service'

class UserService
  def initialize(db)
    @db = db
  end

  def find_user(id)
    @db.find(id)
  end

  def delete_user(id)
    @db.delete(id)
  end
end

class AuthService
  def login(username, password)
    username == "admin"
  end
end

def standalone_helper
  puts "helper"
end
`;

  test("detectLanguage: .rb -> ruby", () => {
    expect(TreeSitterChunker.detectLanguage("foo.rb")).toBe("ruby");
  });

  test("extracts classes with names", async () => {
    const chunks = await chunker.chunkSource(
      RB_SOURCE,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name);
    expect(names).toContain("UserService");
    expect(names).toContain("AuthService");
  });

  test("extracts methods inside class as method type", async () => {
    const chunks = await chunker.chunkSource(
      RB_SOURCE,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    const methods = chunksByType(chunks, "method");
    const names = methods.map((c) => c.name);
    expect(names).toContain("find_user");
    expect(names).toContain("delete_user");
  });

  test("method inside class has metadata.className set", async () => {
    const chunks = await chunker.chunkSource(
      RB_SOURCE,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    const findUser = chunkByName(chunks, "find_user");
    expect(findUser).toBeDefined();
    expect(findUser?.metadata?.className).toBe("UserService");
  });

  test("emits import chunk for require calls", async () => {
    const chunks = await chunker.chunkSource(
      RB_SOURCE,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    const imports = chunksByType(chunks, "import");
    expect(imports.length).toBeGreaterThan(0);
    const importContent = imports.map((c) => c.content).join("\n");
    expect(importContent).toContain("activerecord");
  });

  test("all chunks have language: ruby", async () => {
    const chunks = await chunker.chunkSource(
      RB_SOURCE,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    for (const c of chunks) expect(c.language).toBe("ruby");
  });

  test("contextContent does not leak file path", async () => {
    const chunks = await chunker.chunkSource(
      RB_SOURCE,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    for (const c of chunks) expect(c.contextContent).not.toContain("// File:");
  });
});

describe("Ruby — Rails-style DSL calls", () => {
  const SRC = `class User < ApplicationRecord
  has_many :posts
  belongs_to :organization
  validates :email, presence: true
  before_action :authenticate
  attr_accessor :temporary_token
end
`;

  test("DSL calls inside class body emitted as dsl_call chunks", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    const dslNames = chunksByType(chunks, "dsl_call").map((c) => c.name);
    expect(dslNames).toContain("has_many");
    expect(dslNames).toContain("belongs_to");
    expect(dslNames).toContain("validates");
    expect(dslNames).toContain("before_action");
    expect(dslNames).toContain("attr_accessor");
  });

  test("DSL call has metadata.className set to enclosing class", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    const hasMany = chunksByType(chunks, "dsl_call").find(
      (c) => c.name === "has_many",
    );
    expect(hasMany?.metadata?.className).toBe("User");
  });
});

describe("Graph edges — Ruby EXTENDS", () => {
  const SOURCE = `class AdminService < UserService
  def promote(id)
    id
  end
end

class UserService
  def find(id)
    id
  end
end
`;

  test("emits EXTENDS edge for class < Parent", async () => {
    const { rawEdges } = await chunker.chunkSourceWithEdges(
      SOURCE,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    const ext = rawEdges.filter((e) => e.type === "EXTENDS");
    expect(ext.length).toBeGreaterThan(0);
    expect(ext[0]?.targetSymbol).toBe("UserService");
  });
});
