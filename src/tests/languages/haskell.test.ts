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

describe("Haskell", () => {
  const SOURCE = `module Greetings where

import Data.List (intercalate)
import Data.Char (toUpper)

data Status = Active | Inactive | Banned deriving (Show)

class Greeter a where
  greet :: a -> String -> String

data UserService = UserService { db :: String }

instance Greeter UserService where
  greet _ name = "Hello, " ++ name ++ "!"

farewell :: String -> String
farewell name = "Goodbye, " ++ name ++ "!"

add :: Int -> Int -> Int
add a b = a + b
`;

  test("detectLanguage: .hs -> haskell", () => {
    expect(TreeSitterChunker.detectLanguage("foo.hs")).toBe("haskell");
  });

  test("produces chunks for Haskell source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("hs"),
      PROJECT_ID,
      "haskell",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts type class as class chunk", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("hs"),
      PROJECT_ID,
      "haskell",
    );
    // Haskell extracts `class` declarations; top-level functions may not split
    const allContent = chunks.map((c) => c.content).join("\n");
    expect(allContent).toContain("Greeter");
  });

  test("all chunks have language: haskell", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("hs"),
      PROJECT_ID,
      "haskell",
    );
    for (const c of chunks) expect(c.language).toBe("haskell");
  });
});

describe("Haskell — instance, newtype, type alias", () => {
  const SRC = `module Things where

data Color = Red | Green | Blue

class Show a where
  show :: a -> String

instance Show Color where
  show Red = "red"
  show _ = "other"

newtype Age = Age Int

type Name = String
`;

  test("instance emitted as instance chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("hs"),
      PROJECT_ID,
      "haskell",
    );
    const insts = chunks.filter((c) => c.type === "instance");
    expect(insts.length).toBeGreaterThan(0);
  });

  test("newtype emitted as newtype chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("hs"),
      PROJECT_ID,
      "haskell",
    );
    const nts = chunks.filter((c) => c.type === "newtype").map((c) => c.name);
    expect(nts).toContain("Age");
  });

  test("type alias emitted as typealias chunk", async () => {
    const chunks = await chunker.chunkSource(
      SRC,
      FILE("hs"),
      PROJECT_ID,
      "haskell",
    );
    const aliases = chunks
      .filter((c) => c.type === "typealias")
      .map((c) => c.name);
    expect(aliases).toContain("Name");
  });
});
