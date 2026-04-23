# @upstart.gg/lucerna

## 0.2.5

### Patch Changes

- [#104](https://github.com/upstart-gg/lucerna/pull/104) [`46c7b02`](https://github.com/upstart-gg/lucerna/commit/46c7b02f504f830d33d55de0e3b71dea0377e264) Thanks [@mattallty](https://github.com/mattallty)! - Add configure path

## 0.2.4

### Patch Changes

- [#102](https://github.com/upstart-gg/lucerna/pull/102) [`444e66c`](https://github.com/upstart-gg/lucerna/commit/444e66c37db55f326b9a7c50e6b8ce25b595a723) Thanks [@mattallty](https://github.com/mattallty)! - add debug logs for sqlite & macos

## 0.2.3

### Patch Changes

- [#100](https://github.com/upstart-gg/lucerna/pull/100) [`ac9dec6`](https://github.com/upstart-gg/lucerna/commit/ac9dec640dfbe379ffaa19d32784e0f05a0853bd) Thanks [@mattallty](https://github.com/mattallty)! - enhance SqliteVectorStore with custom SQLite configuration for macOS

## 0.2.2

### Patch Changes

- [#98](https://github.com/upstart-gg/lucerna/pull/98) [`98fe265`](https://github.com/upstart-gg/lucerna/commit/98fe2656858c33044d4c86f35c2bdfb1521a037f) Thanks [@mattallty](https://github.com/mattallty)! - handle error when setting custom SQLite in SqliteVectorStore

## 0.2.1

### Patch Changes

- [#93](https://github.com/upstart-gg/lucerna/pull/93) [`94089d7`](https://github.com/upstart-gg/lucerna/commit/94089d713e571370eced716347869fd4d8521510) Thanks [@mattallty](https://github.com/mattallty)! - Update deps

## 0.2.0

### Minor Changes

- [#90](https://github.com/upstart-gg/lucerna/pull/90) [`9d9ed65`](https://github.com/upstart-gg/lucerna/commit/9d9ed652da83e904cf8f4b0684c9bd21e19b85f6) Thanks [@mattallty](https://github.com/mattallty)! - Expand chunker coverage across all supported languages.

  The `ChunkType` union is extended with a distinct variant for every semantically meaningful construct that was previously collapsed into a coarser type or dropped entirely:

  - `enum`, `const`, `macro`, `namespace`, `struct`, `record`, `protocol`, `trait`, `mixin`, `extension`, `object`, `actor`, `typealias`, `module`, `property`, `instance`, `newtype`, `functor`, `module_type`, `test`, `param_block`, `dsl_call`, `state_variable`, `event`, `modifier`, `error`, `library`.

  New extractions per language (highlights):

  - **TS / JS**: enums, namespaces, top-level `const` (objects/arrays/Zod schemas/route tables, ≥40 chars).
  - **Python**: PEP 695 type aliases, module-level constants, decorators absorbed.
  - **Rust**: modules, `macro_rules!`, consts/statics, type aliases; `struct`/`enum`/`trait` remapped from `class`/`type`/`interface`; `#[derive(...)]` and rustdoc absorbed.
  - **Go**: top-level `const`/`var` (≥40 chars).
  - **Java**: `record`; Javadoc and annotations absorbed; `enum` remapped from `type`.
  - **C#**: `record`/`struct`/`enum` remapped; `property`, `event`, `delegate` (typealias) added; XML doc and `[Attributes]` absorbed.
  - **Ruby**: Rails-style class-body `dsl_call` chunks (`has_many`, `validates`, `before_action`, `attr_accessor`, …).
  - **SQL**: `CREATE FUNCTION`, `CREATE PROCEDURE`, `CREATE TRIGGER`, `CREATE INDEX`, `CREATE SCHEMA`, `ALTER`.
  - **C / C++**: enums, unions, namespaces, typedefs/aliases, `template_declaration`, C `#define` macros.
  - **Swift**: `protocol`/`struct`/`extension`/`actor`/`typealias`/`property`.
  - **Kotlin**: `object`, `enum`, `interface`, `typealias`, top-level `property`.
  - **Scala**: `object`, `trait`, `record` (case class), Scala 3 `enum` and `given` instances, `typealias`.
  - **Dart**: `mixin`, `extension`, `enum`, `typealias`.
  - **Elixir**: `defmacro`, `defprotocol`, `defimpl`, `defstruct`; `@moduledoc`/`@doc`/`@spec` absorbed.
  - **Clojure**: `defprotocol`, `defrecord`/`deftype`, `defmacro`, `defmulti`/`defmethod`, `def` constants.
  - **Solidity**: `library`, `struct`, `enum`, `state_variable`, `error`, `event`, `modifier`.
  - **Svelte / Vue**: `<script>` blocks are now re-parsed as TS/JS so component props (`defineProps`, `export let`), composables, and top-level functions become individual chunks instead of collapsing into a single block.
  - **Objective-C**: `protocol`, category `extension`, `property`.
  - **Zig**: container declarations (struct/enum/union), `test` blocks.
  - **Erlang**: `record` declarations; `-spec` absorbed.
  - **Haskell**: `instance`, `newtype`, `typealias`.
  - **OCaml**: `module_type`, `functor`.
  - **PHP**: `enum` (8.1), `const`, `property`; `trait` remapped from `interface`.
  - **Julia**: `macro`, abstract types, top-level constants.
  - **Matlab**: `properties` blocks inside `classdef`.
  - **Groovy**: top-level closures (`def name = { ... }`) → `function`.
  - **PowerShell**: script-scope `param( ... )` blocks.
  - **Perl**: Moose `has` properties; POD sections absorbed.
  - **R**: S4 `setClass` / `setMethod` / `setGeneric`.
  - **SCSS**: `$variable` constants (≥30 chars), `@keyframes`, `@media` sections.
  - **Bash**: top-level variable assignments (≥40 chars) → `const`.

  Cross-cutting: leading doc comments, decorators, annotations, and attributes are absorbed upward into the chunk that follows them — JSDoc, rustdoc, Python docstrings, Elixir `@doc`, Swift `///`, C# XML docs, Java annotations, Rust attributes, etc. The absorb scan is capped at 80 lines to avoid pulling in license headers.

  **Breaking change for type filters**: chunks previously emitted as `type: "interface"` for traits/protocols, or `type: "type"` for enums, are now emitted with the more specific `trait`/`protocol`/`enum` types. Consumers filtering search results or repo-maps with `types: [...]` should add the corresponding new types to their filter list.

### Patch Changes

- [#92](https://github.com/upstart-gg/lucerna/pull/92) [`056fd10`](https://github.com/upstart-gg/lucerna/commit/056fd10c747529efdee50d226bfddf196a35e787) Thanks [@mattallty](https://github.com/mattallty)! - add excluded files

## 0.1.26

### Patch Changes

- [#85](https://github.com/upstart-gg/lucerna/pull/85) [`1cb94d4`](https://github.com/upstart-gg/lucerna/commit/1cb94d4503b3e2376b09d276c5ee990fe8b02148) Thanks [@mattallty](https://github.com/mattallty)! - Improve metadata

## 0.1.25

### Patch Changes

- [#83](https://github.com/upstart-gg/lucerna/pull/83) [`1804d1e`](https://github.com/upstart-gg/lucerna/commit/1804d1e13c11e019d4d7398ad9e53dfdab833abb) Thanks [@mattallty](https://github.com/mattallty)! - Fix reindexing bug

## 0.1.24

### Patch Changes

- [#81](https://github.com/upstart-gg/lucerna/pull/81) [`81fc234`](https://github.com/upstart-gg/lucerna/commit/81fc2347307a869ee0f8ea0b133d62cd79891201) Thanks [@mattallty](https://github.com/mattallty)! - Vector db improvements (sqlite)

## 0.1.23

### Patch Changes

- [#79](https://github.com/upstart-gg/lucerna/pull/79) [`e1eddd5`](https://github.com/upstart-gg/lucerna/commit/e1eddd5a5900e3efab84911e27fc52ff9efeb22c) Thanks [@mattallty](https://github.com/mattallty)! - Tweak embedding models and add gemini models

## 0.1.22

### Patch Changes

- [#77](https://github.com/upstart-gg/lucerna/pull/77) [`0db8bb1`](https://github.com/upstart-gg/lucerna/commit/0db8bb14a030ec62a04774e53a02ca60949b522c) Thanks [@mattallty](https://github.com/mattallty)! - add ignored patterns

## 0.1.21

### Patch Changes

- [#75](https://github.com/upstart-gg/lucerna/pull/75) [`73b3789`](https://github.com/upstart-gg/lucerna/commit/73b3789f671c7b7708dc856353b19c54ffd378a5) Thanks [@mattallty](https://github.com/mattallty)! - refactor: improve indexing logic

## 0.1.20

### Patch Changes

- [#73](https://github.com/upstart-gg/lucerna/pull/73) [`a2dbe44`](https://github.com/upstart-gg/lucerna/commit/a2dbe44d50ec0243e0c71535012b23dfb32649be) Thanks [@mattallty](https://github.com/mattallty)! - Simplify vertex limits checks

## 0.1.19

### Patch Changes

- [#71](https://github.com/upstart-gg/lucerna/pull/71) [`ff1221d`](https://github.com/upstart-gg/lucerna/commit/ff1221d8b409a547464f3a238dc6e479f20d84ed) Thanks [@mattallty](https://github.com/mattallty)! - Work around providers limits

## 0.1.18

### Patch Changes

- [#69](https://github.com/upstart-gg/lucerna/pull/69) [`7fc9eb6`](https://github.com/upstart-gg/lucerna/commit/7fc9eb60f87bfb637c7e6a595f38fa7a98502188) Thanks [@mattallty](https://github.com/mattallty)! - Change vertex auth

## 0.1.17

### Patch Changes

- [#67](https://github.com/upstart-gg/lucerna/pull/67) [`5517263`](https://github.com/upstart-gg/lucerna/commit/55172639bf9b723fefd9890b1337ddca081f8598) Thanks [@mattallty](https://github.com/mattallty)! - Fix batching limits

## 0.1.16

### Patch Changes

- [#65](https://github.com/upstart-gg/lucerna/pull/65) [`cf6a242`](https://github.com/upstart-gg/lucerna/commit/cf6a242b61ff4b0da5e34b39ff171abb56c370f2) Thanks [@mattallty](https://github.com/mattallty)! - detect pnpm workspace

## 0.1.15

### Patch Changes

- [#63](https://github.com/upstart-gg/lucerna/pull/63) [`b53aaeb`](https://github.com/upstart-gg/lucerna/commit/b53aaebc8293e68e717f3ab5a0fd18ac8f104ff0) Thanks [@mattallty](https://github.com/mattallty)! - Fix install script

## 0.1.14

### Patch Changes

- [#61](https://github.com/upstart-gg/lucerna/pull/61) [`84e8ef8`](https://github.com/upstart-gg/lucerna/commit/84e8ef84b8d58624edf3fa4d46a037b97e6ca94a) Thanks [@mattallty](https://github.com/mattallty)! - add @upstart.gg/lucerna as dev dep

## 0.1.13

### Patch Changes

- [#59](https://github.com/upstart-gg/lucerna/pull/59) [`ba35c15`](https://github.com/upstart-gg/lucerna/commit/ba35c156f683618caab58e1e637f43db006e48f0) Thanks [@mattallty](https://github.com/mattallty)! - Do not use shell:true in install command

## 0.1.12

### Patch Changes

- [#56](https://github.com/upstart-gg/lucerna/pull/56) [`b217997`](https://github.com/upstart-gg/lucerna/commit/b217997de1717a5c1147237a0c6c807cd0a26026) Thanks [@mattallty](https://github.com/mattallty)! - change cli sgnatures

## 0.1.11

### Patch Changes

- [#54](https://github.com/upstart-gg/lucerna/pull/54) [`b1ccf67`](https://github.com/upstart-gg/lucerna/commit/b1ccf67c1822b2f125c8120a7789e84f296b3d3f) Thanks [@mattallty](https://github.com/mattallty)! - Improve cli output

## 0.1.10

### Patch Changes

- [#51](https://github.com/upstart-gg/lucerna/pull/51) [`870b294`](https://github.com/upstart-gg/lucerna/commit/870b29463057fdd57db056b508491ff418ba4611) Thanks [@mattallty](https://github.com/mattallty)! - change MCP server initialization logic

## 0.1.9

### Patch Changes

- [#47](https://github.com/upstart-gg/lucerna/pull/47) [`ea9adb3`](https://github.com/upstart-gg/lucerna/commit/ea9adb3cb9207931e8b36214be28da2764641cd7) Thanks [@mattallty](https://github.com/mattallty)! - add LM Studio embedding provider

- [#45](https://github.com/upstart-gg/lucerna/pull/45) [`e30dd8f`](https://github.com/upstart-gg/lucerna/commit/e30dd8f99d6fdba30bb9c76a6e246ae8fd3fe356) Thanks [@mattallty](https://github.com/mattallty)! - Implement hybrid search with RRF fusion

## 0.1.8

### Patch Changes

- [#43](https://github.com/upstart-gg/lucerna/pull/43) [`5b767ab`](https://github.com/upstart-gg/lucerna/commit/5b767ab5d73df62592b53c5ab1950368da2fa6e4) Thanks [@mattallty](https://github.com/mattallty)! - Update default models for embedding and reranking to voyage-4 and rerank-2.5

## 0.1.7

### Patch Changes

- [#42](https://github.com/upstart-gg/lucerna/pull/42) [`b8d97e3`](https://github.com/upstart-gg/lucerna/commit/b8d97e326f538e0d15f44fd2a7826dbd5c8b7336) Thanks [@mattallty](https://github.com/mattallty)! - Reduce tool output (2nd pass)

- [#40](https://github.com/upstart-gg/lucerna/pull/40) [`527d651`](https://github.com/upstart-gg/lucerna/commit/527d6518b1ab568751bcad3f0fc1a7cd5a5d774f) Thanks [@mattallty](https://github.com/mattallty)! - Enhance tool output

## 0.1.6

### Patch Changes

- [#38](https://github.com/upstart-gg/lucerna/pull/38) [`87e4287`](https://github.com/upstart-gg/lucerna/commit/87e4287bdfb443463edc68554143e6e455a4a084) Thanks [@mattallty](https://github.com/mattallty)! - Rework to use providers + Ollama for local models

## 0.1.5

### Patch Changes

- [#35](https://github.com/upstart-gg/lucerna/pull/35) [`e4c0809`](https://github.com/upstart-gg/lucerna/commit/e4c0809ba0f69a8c7aec2c9c3ccad5c91e096533) Thanks [@mattallty](https://github.com/mattallty)! - chore: fix release PR system

- [`c558b59`](https://github.com/upstart-gg/lucerna/commit/c558b592f042c669f121bbcc9b510eb19bcccec3) Thanks [@mattallty](https://github.com/mattallty)! - Set docs package as private

## 0.1.4

### Patch Changes

- [#30](https://github.com/upstart-gg/lucerna/pull/30) [`9b14189`](https://github.com/upstart-gg/lucerna/commit/9b14189202aa54a64d8358185624256018f58dcd) Thanks [@mattallty](https://github.com/mattallty)! - Implement custom languages & add docs

## 0.1.3

### Patch Changes

- [#28](https://github.com/upstart-gg/lucerna/pull/28) [`e81db25`](https://github.com/upstart-gg/lucerna/commit/e81db25b55f6d49ba5981079266a0f3cde687a94) Thanks [@mattallty](https://github.com/mattallty)! - Tst release workflow with changeset

## 0.1.2

### Patch Changes

- [#19](https://github.com/upstart-gg/lucerna/pull/19) [`75fef64`](https://github.com/upstart-gg/lucerna/commit/75fef64092e5bbe3ab001f458aa716224b349483) Thanks [@mattallty](https://github.com/mattallty)! - Fix release workflow

## 0.1.1

### Patch Changes

- [#17](https://github.com/upstart-gg/lucerna/pull/17) [`86ea9b3`](https://github.com/upstart-gg/lucerna/commit/86ea9b3312b5f3818038acbfb43c565744e8f688) Thanks [@mattallty](https://github.com/mattallty)! - Add mcp server

- [#9](https://github.com/upstart-gg/lucerna/pull/9) [`a5c013c`](https://github.com/upstart-gg/lucerna/commit/a5c013ce18da8493013d3aca013fb58639f1dd9c) Thanks [@mattallty](https://github.com/mattallty)! - Various fixes

- [#11](https://github.com/upstart-gg/lucerna/pull/11) [`017eb36`](https://github.com/upstart-gg/lucerna/commit/017eb36841890c33619caae7b08726caddcc01a6) Thanks [@mattallty](https://github.com/mattallty)! - Fix canary snapshot publishing
