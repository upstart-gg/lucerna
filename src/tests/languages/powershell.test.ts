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

  test("extracts function chunks", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("ps1"),
      PROJECT_ID,
      "powershell",
    );
    const names = chunks
      .filter((c) => c.type === "function")
      .map((c) => c.name);
    expect(names).toContain("Get-Greeting");
    expect(names).toContain("Add-Numbers");
  });
});

describe("PowerShell — script-scope param block", () => {
  const SRC = `param(
    [Parameter(Mandatory)]
    [string] $Name,
    [int] $Count = 1
)

function Get-Greeting {
    param([string] $Name)
    "Hello, $Name"
}
`;

  test("script-scope param block emitted as param_block chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("ps1"),
      PROJECT_ID,
      "powershell",
    );
    const params = chunks.filter((c) => c.type === "param_block");
    expect(params.length).toBeGreaterThan(0);
  });
});
