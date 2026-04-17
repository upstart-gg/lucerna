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

describe("Objective-C", () => {
  const SOURCE = `#import <Foundation/Foundation.h>
#import "MyClass.h"

@interface MyClass : NSObject
- (void)greet:(NSString *)name;
+ (instancetype)create;
@end

@implementation MyClass
- (void)greet:(NSString *)name {
    NSLog(@"Hello %@", name);
}

+ (instancetype)create {
    return [super new];
}
@end
`;

  test("detectLanguage: .m -> objc", () => {
    expect(TreeSitterChunker.detectLanguage("foo.m")).toBe("objc");
  });

  test("detectLanguage: .mm -> objc", () => {
    expect(TreeSitterChunker.detectLanguage("foo.mm")).toBe("objc");
  });

  test("produces chunks for Objective-C source", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("m"),
      PROJECT_ID,
      "objc",
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("extracts class interface", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("m"),
      PROJECT_ID,
      "objc",
    );
    const classChunk = chunks.find(
      (c) => c.type === "class" && c.name === "MyClass",
    );
    expect(classChunk).toBeDefined();
  });

  test("extracts methods", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("m"),
      PROJECT_ID,
      "objc",
    );
    const methodNames = chunks
      .filter((c) => c.type === "method")
      .map((c) => c.name);
    expect(methodNames).toContain("greet");
  });

  test("extracts import chunk from #import directives", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("m"),
      PROJECT_ID,
      "objc",
    );
    const importChunk = chunks.find((c) => c.type === "import");
    expect(importChunk).toBeDefined();
    expect(importChunk?.content).toContain("#import");
  });

  test("all chunks have language: objc", async () => {
    const chunks = await chunker.chunkSource(
      SOURCE,
      FILE("m"),
      PROJECT_ID,
      "objc",
    );
    for (const c of chunks) expect(c.language).toBe("objc");
  });
});
