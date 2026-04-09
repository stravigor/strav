# @strav/brain

Multi-provider AI module with agents, tool use, structured output, multi-turn threads, and workflow orchestration. Supports Anthropic, OpenAI, Google Gemini, and DeepSeek. Zero SDK dependencies — all provider communication uses raw fetch().

## Dependencies
- @strav/kernel (peer)
- @strav/workflow (peer)

## Commands
- bun test
- bun run build

## Architecture
- src/brain_manager.ts — main manager class
- src/brain_provider.ts — service provider registration
- src/agent.ts — AI agent abstraction
- src/tool.ts — tool definitions for AI tool use
- src/workflow.ts — AI workflow orchestration (uses @strav/workflow)
- src/providers/ — provider implementations (Anthropic, OpenAI, Google, DeepSeek)
- src/memory/ — conversation memory management (token counting, compaction, semantic facts, persistence)
- src/utils/ — shared utilities
- src/types.ts — type definitions

## Memory system
- Opt-in via `thread.memory()` — without it, Thread behaves as before
- Three tiers: working memory (recent messages), episodic memory (LLM summaries), semantic memory (extracted facts)
- TokenCounter estimates tokens (~4 chars/token), ContextBudget allocates the context window
- MemoryManager orchestrates compaction when over budget (SummarizeStrategy or SlidingWindowStrategy)
- SemanticMemory stores key-value facts injected into the system prompt as `<known_facts>`
- ThreadStore interface for pluggable persistence — InMemoryThreadStore ships as default
- BrainManager.useThreadStore() registers a store; thread.persist() enables auto-save

## Conventions
- Providers implement a common interface — no SDK dependencies, raw fetch() only
- Tools are defined declaratively and passed to agents
- Workflows compose agents and tools into multi-step processes via @strav/workflow
- Memory is opt-in and backward-compatible — existing Thread API unchanged without .memory()
