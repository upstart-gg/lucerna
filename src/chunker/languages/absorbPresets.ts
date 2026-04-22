import type { AbsorbConfig } from "./shared.js";

const JSDOC_BLOCKS = [
  { open: "/**", close: "*/" },
  { open: "/*", close: "*/" },
];
const PHPDOC_BLOCKS = [{ open: "/**", close: "*/" }];
const SCALADOC_BLOCKS = [{ open: "/**", close: "*/" }];

const DECORATOR_AT = /^@\w/;
const CSHARP_ATTRIBUTE = /^\[[A-Za-z_]/;
const RUST_ATTRIBUTE = /^#!?\[/;
const PHP_ATTRIBUTE = /^#\[\w/;
const JAVA_ANNOTATION = /^@[A-Z]\w*/;

export const ABSORB_PRESETS: Record<string, AbsorbConfig> = {
  typescript: {
    linePrefixes: ["//"],
    blockComments: JSDOC_BLOCKS,
    linePatterns: [DECORATOR_AT],
  },
  javascript: {
    linePrefixes: ["//"],
    blockComments: JSDOC_BLOCKS,
    linePatterns: [DECORATOR_AT],
  },
  python: {
    linePrefixes: ["#"],
    linePatterns: [DECORATOR_AT],
  },
  rust: {
    linePrefixes: ["//", "///", "//!"],
    blockComments: JSDOC_BLOCKS,
    linePatterns: [RUST_ATTRIBUTE],
  },
  go: {
    linePrefixes: ["//"],
    blockComments: [{ open: "/*", close: "*/" }],
  },
  java: {
    linePrefixes: ["//"],
    blockComments: [{ open: "/**", close: "*/" }],
    linePatterns: [JAVA_ANNOTATION],
  },
  csharp: {
    linePrefixes: ["//", "///"],
    blockComments: [{ open: "/*", close: "*/" }],
    linePatterns: [CSHARP_ATTRIBUTE],
  },
  kotlin: {
    linePrefixes: ["//"],
    blockComments: [{ open: "/**", close: "*/" }],
    linePatterns: [DECORATOR_AT],
  },
  swift: {
    linePrefixes: ["//", "///"],
    blockComments: [{ open: "/**", close: "*/" }],
    linePatterns: [DECORATOR_AT],
  },
  scala: {
    linePrefixes: ["//"],
    blockComments: SCALADOC_BLOCKS,
    linePatterns: [DECORATOR_AT],
  },
  dart: {
    linePrefixes: ["//", "///"],
    blockComments: [{ open: "/**", close: "*/" }],
    linePatterns: [DECORATOR_AT],
  },
  elixir: {
    linePrefixes: ["#"],
    linePatterns: [
      /^@(doc|moduledoc|spec|typedoc|type|typep|opaque|callback)\b/,
    ],
  },
  clojure: {
    linePrefixes: [";;;", ";;", ";"],
  },
  ruby: {
    linePrefixes: ["#"],
  },
  php: {
    linePrefixes: ["//", "#"],
    blockComments: PHPDOC_BLOCKS,
    linePatterns: [PHP_ATTRIBUTE, DECORATOR_AT],
  },
  c: {
    linePrefixes: ["//"],
    blockComments: JSDOC_BLOCKS,
  },
  cpp: {
    linePrefixes: ["//"],
    blockComments: JSDOC_BLOCKS,
  },
  objc: {
    linePrefixes: ["//"],
    blockComments: JSDOC_BLOCKS,
  },
  haskell: {
    linePrefixes: ["--"],
    blockComments: [
      { open: "{-|", close: "-}" },
      { open: "{-", close: "-}" },
    ],
  },
  ocaml: {
    blockComments: [
      { open: "(**", close: "*)" },
      { open: "(*", close: "*)" },
    ],
  },
  lua: {
    linePrefixes: ["--"],
    blockComments: [{ open: "--[[", close: "]]" }],
  },
  r: {
    linePrefixes: ["#"],
  },
  bash: {
    linePrefixes: ["#"],
  },
  sql: {
    linePrefixes: ["--"],
    blockComments: [{ open: "/*", close: "*/" }],
  },
  matlab: {
    linePrefixes: ["%%", "%"],
    blockComments: [{ open: "%{", close: "%}" }],
  },
  powershell: {
    linePrefixes: ["#"],
    blockComments: [{ open: "<#", close: "#>" }],
  },
  perl: {
    linePrefixes: ["#"],
    blockComments: [{ open: "=", close: "=cut" }],
  },
  zig: {
    linePrefixes: ["//", "///"],
  },
  erlang: {
    linePrefixes: ["%"],
    linePatterns: [/^-(spec|doc|type|typedoc|opaque|callback)\b/],
  },
  julia: {
    linePrefixes: ["#"],
    blockComments: [{ open: "#=", close: "=#" }],
    linePatterns: [DECORATOR_AT],
  },
  solidity: {
    linePrefixes: ["//", "///"],
    blockComments: JSDOC_BLOCKS,
  },
  scss: {
    linePrefixes: ["//"],
    blockComments: [{ open: "/*", close: "*/" }],
  },
  css: {
    blockComments: [{ open: "/*", close: "*/" }],
  },
  groovy: {
    linePrefixes: ["//"],
    blockComments: [{ open: "/**", close: "*/" }],
    linePatterns: [DECORATOR_AT],
  },
};

export function getAbsorb(language: string): AbsorbConfig | undefined {
  return ABSORB_PRESETS[language];
}
