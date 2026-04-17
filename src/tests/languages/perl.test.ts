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

describe("Perl", () => {
  const SOURCE = `use strict;
use warnings;
use List::Util qw(sum);

sub greet {
    my ($name) = @_;
    return "Hello, $name!";
}

sub farewell {
    my ($name) = @_;
    return "Goodbye, $name!";
}

sub add {
    my ($a, $b) = @_;
    return $a + $b;
}
`;

  test("detectLanguage: .pl -> perl", () => {
    expect(TreeSitterChunker.detectLanguage("foo.pl")).toBe("perl");
  });

  test("detectLanguage: .pm -> perl", () => {
    expect(TreeSitterChunker.detectLanguage("foo.pm")).toBe("perl");
  });

  test("produces chunks for Perl source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("pl"),
      PROJECT_ID,
      "perl",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("chunk content contains subroutine source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("pl"),
      PROJECT_ID,
      "perl",
    );
    // Perl falls back to a whole-file chunk
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("greet");
    expect(allContent).toContain("farewell");
  });

  test("all chunks have language: perl", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("pl"),
      PROJECT_ID,
      "perl",
    );
    for (const c of chunks) expect(c.language).toBe("perl");
  });
});
