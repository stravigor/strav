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

## Prompt-injection threat model

`agent.instructions` supports `{{key}}` placeholders that are filled in from `agent.with({ ... })` context (see `interpolateInstructions` in `src/utils/prompt.ts`). The substitution drops string values directly into the **system role** of the request sent to the LLM provider — anything user-controlled flowing through this channel is a prompt-injection vector. The model has no way to tell the difference between developer-authored instructions and runtime-substituted user input.

Rules for callers:

- **Never** put untrusted user input into agent context. The right place for runtime user input is `runner.input(userMessage)` — that lands in the `user` role, where the model expects untrusted content.
- Use context for **trusted** values only: `userId`, `tenantId`, request metadata your application controls.
- If you must mix untrusted text into a prompt, send it as an extra `user`-role message (e.g., `messages: [{ role: 'user', content: 'Here is the user note: <<<' + note + '>>>' }]`), not as a system-prompt placeholder.

Defense-in-depth in the framework:

- `interpolateInstructions()` runs every context value through `looksLikePromptInjection()` and emits `console.warn` when a value contains markers commonly used to override system instructions ("ignore previous", "system:", `<|im_start|>`, `[INST]`, role-switch phrases, etc.). The warning is informational — the substitution still happens — so developers see when something looks suspicious during local runs and CI logs.
- The detector is intentionally loose. False positives are cheap; missed exploits are not.

Future work (out of scope of the current fix): replace `{{key}}` system-role interpolation with a structured-context API so untrusted values can be passed without ever touching the system role.
