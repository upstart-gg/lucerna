---
"@upstart.gg/lucerna": minor
---

Expand chunker coverage across all supported languages.

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
