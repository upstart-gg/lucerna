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

describe("SQL", () => {
  const SQL_SOURCE = `CREATE TABLE users (
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

  test("emits a named chunk for each CREATE TABLE statement", async () => {
    const chunks = await chunker.chunkSource(
      SQL_SOURCE,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    const names = chunks.map((c) => c.name).filter(Boolean);
    expect(names).toContain("CREATE TABLE users");
    expect(names).toContain("CREATE TABLE orders");
  });

  test("emits a chunk for SELECT statement", async () => {
    const chunks = await chunker.chunkSource(
      SQL_SOURCE,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    const names = chunks.map((c) => c.name).filter(Boolean);
    expect(names).toContain("SELECT");
  });

  test("produces at least 3 chunks for 2 CREATE TABLE + 1 SELECT", async () => {
    const chunks = await chunker.chunkSource(
      SQL_SOURCE,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  test("chunk content contains semicolon", async () => {
    const chunks = await chunker.chunkSource(
      SQL_SOURCE,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain(";");
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

describe("SQL — functions, procedures, triggers, indexes", () => {
  const SRC = `CREATE FUNCTION calc_total(amount DECIMAL) RETURNS DECIMAL AS $$
BEGIN
    RETURN amount * 1.2;
END;
$$ LANGUAGE plpgsql;

CREATE PROCEDURE refresh_caches() AS $$
BEGIN
    PERFORM pg_stat_reset();
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_modified BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_modified();

CREATE INDEX idx_users_email ON users (email);
`;

  test("emits a chunk for CREATE FUNCTION", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("CREATE FUNCTION calc_total");
  });

  test("emits a chunk for CREATE PROCEDURE", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("CREATE PROCEDURE refresh_caches");
  });

  test("emits a chunk for CREATE TRIGGER", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("CREATE TRIGGER update_modified");
  });

  test("emits a chunk for CREATE INDEX", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("sql"),
      PROJECT_ID,
      "sql",
    );
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("CREATE INDEX idx_users_email");
  });
});
