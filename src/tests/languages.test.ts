import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TreeSitterChunker } from "../chunker/index.js";
import type { ChunkType, CodeChunk } from "../types.js";

// Tests for every language supported by @kreuzberg/tree-sitter-language-pack.
// Languages are lazily initialized on first use — no extraLanguages needed.

const PROJECT_ID = "test-lang";
const FILE = (ext: string) => `test/src/sample.${ext}`;

let chunker: TreeSitterChunker;

beforeAll(async () => {
  // No extraLanguages — tests exercise the lazy-init path for all non-default langs.
  chunker = new TreeSitterChunker({});
  await chunker.initialize();
});

afterAll(async () => {
  await chunker.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunksByType(chunks: CodeChunk[], type: ChunkType): CodeChunk[] {
  return chunks.filter((c) => c.type === type);
}

function chunkByName(chunks: CodeChunk[], name: string): CodeChunk | undefined {
  return chunks.find((c) => c.name === name);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

describe("Python", () => {
  const PY_SOURCE = `
def greet(name):
    return f"Hello, {name}!"

def farewell(name):
    return f"Goodbye, {name}!"

class UserService:
    def __init__(self, db):
        self.db = db

    def find_user(self, user_id):
        return self.db.find(user_id)

    def delete_user(self, user_id):
        self.db.delete(user_id)
`;

  test("detectLanguage: .py -> python", () => {
    expect(TreeSitterChunker.detectLanguage("foo.py")).toBe("python");
  });

  test("detectLanguage: .pyw -> python", () => {
    expect(TreeSitterChunker.detectLanguage("foo.pyw")).toBe("python");
  });

  test("lazy-init: no extraLanguages needed for python", async () => {
    const freshChunker = new TreeSitterChunker({});
    await freshChunker.initialize();
    const chunks = await freshChunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    expect(chunks.length).toBeGreaterThan(0);
    await freshChunker.close();
  });

  test("extracts top-level functions", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
    expect(names).toContain("farewell");
  });

  test("extracts class", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    const cls = chunksByType(chunks, "class");
    expect(cls.length).toBeGreaterThan(0);
    expect(cls[0]?.name).toBe("UserService");
  });

  test("extracts methods as children of class", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    const fns = chunksByType(chunks, "function");
    const methodNames = fns.map((c) => c.name);
    expect(methodNames).toContain("find_user");
    expect(methodNames).toContain("delete_user");
  });

  test("class method contextContent contains class breadcrumb", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    const findUser = chunkByName(chunks, "find_user");
    expect(findUser).toBeDefined();
    expect(findUser?.contextContent).toContain("// Class: UserService");
  });

  test("all chunks have language: python", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    for (const c of chunks) expect(c.language).toBe("python");
  });

  test("all chunks contextContent starts with // File:", async () => {
    const chunks = await chunker.chunkSource(
      PY_SOURCE,
      FILE("py"),
      PROJECT_ID,
      "python",
    );
    for (const c of chunks) expect(c.contextContent).toContain("// File:");
  });
});

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

describe("Rust", () => {
  const RS_SOURCE = `
pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

pub fn farewell(name: &str) -> String {
    format!("Goodbye, {}!", name)
}

pub struct UserService {
    db: String,
}

impl UserService {
    pub fn new(db: String) -> Self {
        Self { db }
    }

    pub fn find_user(&self, id: &str) -> Option<String> {
        Some(self.db.clone())
    }
}

pub trait Greeter {
    fn greet(&self) -> String;
}

pub enum Status {
    Active,
    Inactive,
    Banned,
}
`;

  test("detectLanguage: .rs -> rust", () => {
    expect(TreeSitterChunker.detectLanguage("foo.rs")).toBe("rust");
  });

  test("extracts top-level functions", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("greet");
    expect(names).toContain("farewell");
  });

  test("struct maps to class type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name).filter(Boolean);
    expect(names).toContain("UserService");
  });

  test("impl block maps to class type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const cls = chunksByType(chunks, "class");
    // impl UserService is unnamed but should be present
    expect(cls.length).toBeGreaterThanOrEqual(1);
  });

  test("impl methods are extracted as functions", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("new");
    expect(names).toContain("find_user");
  });

  test("trait maps to interface type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const ifaces = chunksByType(chunks, "interface");
    expect(ifaces.length).toBeGreaterThan(0);
    expect(ifaces[0]?.name).toBe("Greeter");
  });

  test("enum maps to type", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    const types = chunksByType(chunks, "type");
    expect(types.length).toBeGreaterThan(0);
    expect(types[0]?.name).toBe("Status");
  });

  test("all chunks have language: rust", async () => {
    const chunks = await chunker.chunkSource(
      RS_SOURCE,
      FILE("rs"),
      PROJECT_ID,
      "rust",
    );
    for (const c of chunks) expect(c.language).toBe("rust");
  });
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

describe("Go", () => {
  const GO_SOURCE = `package main

import "fmt"

func Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

func Farewell(name string) string {
	return fmt.Sprintf("Goodbye, %s!", name)
}

type UserService struct {
	db string
}

func (u *UserService) FindUser(id string) string {
	return u.db
}

func (u *UserService) DeleteUser(id string) {
	_ = id
}
`;

  test("detectLanguage: .go -> go", () => {
    expect(TreeSitterChunker.detectLanguage("foo.go")).toBe("go");
  });

  test("extracts top-level functions", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("Greet");
    expect(names).toContain("Farewell");
  });

  test("extracts receiver methods as method type", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    const methods = chunksByType(chunks, "method");
    const names = methods.map((c) => c.name);
    expect(names).toContain("FindUser");
    expect(names).toContain("DeleteUser");
  });

  // Note: Go struct/interface type declarations are not emitted in the pack's
  // structure output — only functions and methods are returned.
  test("at least one chunk per function/method", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    expect(chunks.length).toBeGreaterThanOrEqual(4); // Greet, Farewell, FindUser, DeleteUser
  });

  test("all chunks have language: go", async () => {
    const chunks = await chunker.chunkSource(
      GO_SOURCE,
      FILE("go"),
      PROJECT_ID,
      "go",
    );
    for (const c of chunks) expect(c.language).toBe("go");
  });
});

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

describe("Java", () => {
  const JAVA_SOURCE = `
public interface Greeter {
    String greet(String name);
}

public class UserService implements Greeter {
    private final String db;

    public UserService(String db) {
        this.db = db;
    }

    @Override
    public String greet(String name) {
        return "Hello, " + name + "!";
    }

    public String findUser(String id) {
        return db;
    }
}
`;

  test("detectLanguage: .java -> java", () => {
    expect(TreeSitterChunker.detectLanguage("Foo.java")).toBe("java");
  });

  test("extracts interface", async () => {
    const chunks = await chunker.chunkSource(
      JAVA_SOURCE,
      FILE("java"),
      PROJECT_ID,
      "java",
    );
    const ifaces = chunksByType(chunks, "interface");
    expect(ifaces.length).toBeGreaterThan(0);
    expect(ifaces[0]?.name).toBe("Greeter");
  });

  test("extracts class", async () => {
    const chunks = await chunker.chunkSource(
      JAVA_SOURCE,
      FILE("java"),
      PROJECT_ID,
      "java",
    );
    const cls = chunksByType(chunks, "class");
    expect(cls.length).toBeGreaterThan(0);
    expect(cls[0]?.name).toBe("UserService");
  });

  test("extracts methods as children", async () => {
    const chunks = await chunker.chunkSource(
      JAVA_SOURCE,
      FILE("java"),
      PROJECT_ID,
      "java",
    );
    const methods = chunksByType(chunks, "method");
    const names = methods.map((c) => c.name);
    expect(names).toContain("greet");
    expect(names).toContain("findUser");
  });

  test("all chunks have language: java", async () => {
    const chunks = await chunker.chunkSource(
      JAVA_SOURCE,
      FILE("java"),
      PROJECT_ID,
      "java",
    );
    for (const c of chunks) expect(c.language).toBe("java");
  });
});

// ---------------------------------------------------------------------------
// C
// ---------------------------------------------------------------------------

describe("C", () => {
  const C_SOURCE = `
#include <stdio.h>
#include <string.h>

int add(int a, int b) {
    return a + b;
}

int multiply(int a, int b) {
    return a * b;
}

void print_greeting(const char *name) {
    printf("Hello, %s!\\n", name);
}
`;

  test("detectLanguage: .c -> c", () => {
    expect(TreeSitterChunker.detectLanguage("foo.c")).toBe("c");
  });

  test("detectLanguage: .h -> c", () => {
    expect(TreeSitterChunker.detectLanguage("foo.h")).toBe("c");
  });

  // Note: the pack extracts C functions but may not include their names in
  // the structure output. At minimum, non-empty chunks must be returned.
  test("produces at least one chunk", async () => {
    const chunks = await chunker.chunkSource(
      C_SOURCE,
      FILE("c"),
      PROJECT_ID,
      "c",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("function chunks are extracted", async () => {
    const chunks = await chunker.chunkSource(
      C_SOURCE,
      FILE("c"),
      PROJECT_ID,
      "c",
    );
    const fns = chunksByType(chunks, "function");
    expect(fns.length).toBeGreaterThan(0);
  });

  test("all chunks have language: c", async () => {
    const chunks = await chunker.chunkSource(
      C_SOURCE,
      FILE("c"),
      PROJECT_ID,
      "c",
    );
    for (const c of chunks) expect(c.language).toBe("c");
  });

  test("chunk content contains function source", async () => {
    const chunks = await chunker.chunkSource(
      C_SOURCE,
      FILE("c"),
      PROJECT_ID,
      "c",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("return a + b");
  });
});

// ---------------------------------------------------------------------------
// C++
// ---------------------------------------------------------------------------

describe("C++", () => {
  const CPP_SOURCE = `
#include <string>

class Animal {
public:
    virtual std::string speak() const = 0;
    void sleep() { }
};

class Dog : public Animal {
public:
    std::string speak() const override {
        return "Woof";
    }
};

int add(int a, int b) {
    return a + b;
}
`;

  test("detectLanguage: .cpp -> cpp", () => {
    expect(TreeSitterChunker.detectLanguage("foo.cpp")).toBe("cpp");
  });

  test("detectLanguage: .hpp -> cpp", () => {
    expect(TreeSitterChunker.detectLanguage("foo.hpp")).toBe("cpp");
  });

  test("detectLanguage: .cc -> cpp", () => {
    expect(TreeSitterChunker.detectLanguage("foo.cc")).toBe("cpp");
  });

  test("extracts class chunks", async () => {
    const chunks = await chunker.chunkSource(
      CPP_SOURCE,
      FILE("cpp"),
      PROJECT_ID,
      "cpp",
    );
    const cls = chunksByType(chunks, "class");
    // Pack extracts classes but may not include names — at least 1 class chunk expected
    expect(cls.length).toBeGreaterThanOrEqual(1);
  });

  test("extracts free function", async () => {
    const chunks = await chunker.chunkSource(
      CPP_SOURCE,
      FILE("cpp"),
      PROJECT_ID,
      "cpp",
    );
    const fns = chunksByType(chunks, "function");
    expect(fns.length).toBeGreaterThan(0);
  });

  test("all chunks have language: cpp", async () => {
    const chunks = await chunker.chunkSource(
      CPP_SOURCE,
      FILE("cpp"),
      PROJECT_ID,
      "cpp",
    );
    for (const c of chunks) expect(c.language).toBe("cpp");
  });
});

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

describe("Ruby", () => {
  const RB_SOURCE = `
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
`;

  test("detectLanguage: .rb -> ruby", () => {
    expect(TreeSitterChunker.detectLanguage("foo.rb")).toBe("ruby");
  });

  test("extracts classes", async () => {
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

  test("all chunks have language: ruby", async () => {
    const chunks = await chunker.chunkSource(
      RB_SOURCE,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    for (const c of chunks) expect(c.language).toBe("ruby");
  });

  test("contextContent contains file breadcrumb", async () => {
    const chunks = await chunker.chunkSource(
      RB_SOURCE,
      FILE("rb"),
      PROJECT_ID,
      "ruby",
    );
    for (const c of chunks) expect(c.contextContent).toContain("// File:");
  });
});

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

describe("PHP", () => {
  const PHP_SOURCE = `<?php

function greet(string $name): string {
    return "Hello, $name!";
}

function farewell(string $name): string {
    return "Goodbye, $name!";
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

  test("extracts class", async () => {
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

  test("extracts class methods", async () => {
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

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

describe("Swift", () => {
  // Pack emits structs as Class kind; protocols are not emitted.
  const SWIFT_SOURCE = `
import Foundation

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

func greet(name: String) -> String {
    return "Hello, \\(name)!"
}
`;

  test("detectLanguage: .swift -> swift", () => {
    expect(TreeSitterChunker.detectLanguage("foo.swift")).toBe("swift");
  });

  test("extracts struct/class as class type", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const cls = chunksByType(chunks, "class");
    const names = cls.map((c) => c.name).filter(Boolean);
    // Pack emits Swift struct as Class
    expect(names).toContain("UserService");
    expect(names).toContain("AuthService");
  });

  test("extracts methods as children", async () => {
    const chunks = await chunker.chunkSource(
      SWIFT_SOURCE,
      FILE("swift"),
      PROJECT_ID,
      "swift",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    expect(names).toContain("findUser");
    expect(names).toContain("deleteUser");
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

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

describe("Kotlin", () => {
  // Pack extracts Kotlin class structure but may not include names.
  const KT_SOURCE = `
package com.example

class UserService(private val db: String) {
    fun findUser(id: String): String? = db

    fun deleteUser(id: String) {
        println("deleted $id")
    }
}

data class User(val id: String, val name: String)

fun greet(name: String): String = "Hello, $name!"
`;

  test("detectLanguage: .kt -> kotlin", () => {
    expect(TreeSitterChunker.detectLanguage("foo.kt")).toBe("kotlin");
  });

  test("detectLanguage: .kts -> kotlin", () => {
    expect(TreeSitterChunker.detectLanguage("foo.kts")).toBe("kotlin");
  });

  test("produces non-empty chunks", async () => {
    const chunks = await chunker.chunkSource(
      KT_SOURCE,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts class chunks", async () => {
    const chunks = await chunker.chunkSource(
      KT_SOURCE,
      FILE("kt"),
      PROJECT_ID,
      "kotlin",
    );
    const cls = chunksByType(chunks, "class");
    // Pack extracts classes; names may be absent for some Kotlin constructs
    expect(cls.length).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

describe("C#", () => {
  const CS_SOURCE = `
using System;

public interface IGreeter {
    string Greet(string name);
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
    expect(cls.length).toBeGreaterThan(0);
    expect(cls[0]?.name).toBe("UserService");
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

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

describe("Bash", () => {
  const SH_SOURCE = `#!/bin/bash

function greet() {
    local name=$1
    echo "Hello, $name!"
}

deploy() {
    echo "deploying..."
    greet world
}

cleanup() {
    rm -rf /tmp/build
}
`;

  test("detectLanguage: .sh -> bash", () => {
    expect(TreeSitterChunker.detectLanguage("foo.sh")).toBe("bash");
  });

  test("detectLanguage: .bash -> bash", () => {
    expect(TreeSitterChunker.detectLanguage("foo.bash")).toBe("bash");
  });

  test("extracts all functions", async () => {
    const chunks = await chunker.chunkSource(
      SH_SOURCE,
      FILE("sh"),
      PROJECT_ID,
      "bash",
    );
    const fns = chunksByType(chunks, "function");
    const names = fns.map((c) => c.name);
    // Both 'function foo()' and 'bar()' syntax should be captured
    expect(names).toContain("greet");
    expect(names).toContain("deploy");
    expect(names).toContain("cleanup");
  });

  test("all chunks have language: bash", async () => {
    const chunks = await chunker.chunkSource(
      SH_SOURCE,
      FILE("sh"),
      PROJECT_ID,
      "bash",
    );
    for (const c of chunks) expect(c.language).toBe("bash");
  });
});

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

describe("SQL", () => {
  const SQL_SOURCE = `
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    total DECIMAL(10, 2) NOT NULL
);

SELECT u.name, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id, u.name;
`;

  test("detectLanguage: .sql -> sql", () => {
    expect(TreeSitterChunker.detectLanguage("foo.sql")).toBe("sql");
  });

  // The pack returns no structure for SQL — lucerna falls back to a single file chunk.
  test("produces at least one chunk containing SQL content", async () => {
    const chunks = await chunker.chunkSource(
      SQL_SOURCE,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    expect(chunks.length).toBeGreaterThan(0);
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("CREATE TABLE");
  });

  test("fallback chunk has type file", async () => {
    const chunks = await chunker.chunkSource(
      SQL_SOURCE,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    // SQL has no structure output, so all chunks are file-type fallbacks
    expect(chunks.every((c) => c.type === "file")).toBe(true);
  });

  test("all chunks have language: sql", async () => {
    const chunks = await chunker.chunkSource(
      SQL_SOURCE,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    for (const c of chunks) expect(c.language).toBe("sql");
  });
});

// ---------------------------------------------------------------------------
// Unsupported language
// ---------------------------------------------------------------------------

describe("unsupported language", () => {
  test("returns empty chunks for a language the pack does not know", async () => {
    const chunks = await chunker.chunkSource(
      "some content",
      "test.xyz",
      PROJECT_ID,
      "xyzlanguagethatdoesnotexist",
    );
    expect(chunks).toEqual([]);
  });
});
