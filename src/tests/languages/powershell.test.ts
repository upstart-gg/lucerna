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

describe("PowerShell", () => {
  const SOURCE = `function Get-Greeting {
    param([string]$Name)
    return "Hello, $Name!"
}

function Remove-User {
    param([string]$Id)
    Write-Host "Removing user $Id"
}

function Add-Numbers {
    param([int]$A, [int]$B)
    return $A + $B
}
`;

  test("detectLanguage: .ps1 -> powershell", () => {
    expect(TreeSitterChunker.detectLanguage("foo.ps1")).toBe("powershell");
  });

  test("produces chunks for PowerShell source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ps1"),
      PROJECT_ID,
      "powershell",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("produces chunks for PowerShell source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ps1"),
      PROJECT_ID,
      "powershell",
    );
    // PowerShell falls back to a whole-file chunk
    expect(chunks.length).toBeGreaterThan(0);
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("Get-Greeting");
  });

  test("all chunks have language: powershell", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ps1"),
      PROJECT_ID,
      "powershell",
    );
    for (const c of chunks) expect(c.language).toBe("powershell");
  });
});
