# Changelog

## 0.2.12

### Added

- **GoogleProvider** — Support for Google's Gemini models
  - Native Gemini API integration using `generativelanguage.googleapis.com`
  - Support for completion, streaming, function calling, and embeddings
  - Models: `gemini-2.0-flash`, `gemini-2.5-flash`, `gemini-3-pro-preview`
  - Authentication via `x-goog-api-key` header
  - Zero new dependencies — uses raw `fetch()` following existing patterns
  - Comprehensive test suite with 29 tests covering all functionality

## 0.6.0

### Added

- **Memory management** — three-tier conversation memory system for long-running threads
  - `thread.memory()` enables opt-in context window management
  - **Working memory** — recent messages within token budget
  - **Episodic memory** — LLM-generated summaries of compacted older messages
  - **Semantic memory** — structured facts extracted from conversation, injected into system prompt
- `TokenCounter` — approximate token estimation per provider (~4 chars/token)
- `ContextBudget` — budget allocation across system prompt, summaries, facts, and working messages
- `MemoryManager` — orchestrates compaction and fact extraction
- `SemanticMemory` — in-memory fact store with `<known_facts>` prompt injection
- `SummarizeStrategy` — LLM-powered compaction with optional fact extraction
- `SlidingWindowStrategy` — drop oldest messages without summarization
- `InMemoryThreadStore` — default `ThreadStore` implementation for dev/testing
- `ThreadStore` interface — pluggable persistence (implement for database-backed storage)
- `BrainManager.useThreadStore()` — register a thread store for persistence
- `BrainManager.memoryConfig` / `BrainManager.threadStore` — accessors for memory configuration
- `thread.id()` — set thread identifier for persistence
- `thread.persist()` — enable auto-save to ThreadStore after each `send()`
- `thread.facts` / `thread.episodicSummary` — access memory state
- `thread.serializeMemory()` / `thread.restoreMemory()` — extended serialization with memory state
- `BrainConfig.memory` — optional `MemoryConfig` field for global memory settings

## 0.1.1

### Changed

- Applied consistent code formatting across all source files
