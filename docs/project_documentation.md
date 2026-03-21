# OpenAI_studio_vLLM_Agent — Technical Documentation

## Architecture Overview

This extension implements a **multi-agent software development system** inspired by ChatDev, running entirely locally via a vLLM-compatible backend.

### System Layers

```text
┌──────────────────────────────────────────┐
│              VS Code Extension UI         │
│         (Webview: chat_webview.ts)        │
├──────────────────────────────────────────┤
│              Chat Chain Orchestrator      │
│            (chat_chain.ts + phase.ts)     │
│                                          │
│  Phase 1: Demand Analysis (CEO)    ◄──HITL (Plan Verification)
│  Phase 2: System Architecture (CTO)
│  Phase 3: Security Audit / DB Optimization
│  Phase 4: Coding (Programmer)      ◄──HITL (Code Review)
│  Phase 5: Documentation (TechWriter)
├──────────────────────────────────────────┤
│             Agent Communication Layer     │
│  (chat_agent.ts + model_backend.ts)      │
│                                          │
│  ┌─────────────────┐  ┌───────────────┐  │
│  │  Model Routing  │  │  Skill Loader │  │
│  │  qwen / codestral  │  │  TF-IDF IDF │  │
│  └─────────────────┘  └───────────────┘  │
├──────────────────────────────────────────┤
│         Tool System (tools.ts)            │
│  read_file | write_file | web_search     │
│  delegate_to_expert | save_skill         │
├──────────────────────────────────────────┤
│     vLLM Server: http://10.1.0.102:8050  │
└──────────────────────────────────────────┘
```

## Key Files

| File | Description |
|------|-------------|
| `src/extension.ts` | Entry point. Defines and registers the full agent pipeline. |
| `src/chatdev/chat_chain.ts` | Orchestrates the execution of all phases sequentially. |
| `src/chatdev/phase.ts` | A single dialogue loop between two agents. |
| `src/camel/chat_agent.ts` | Base agent class (role, system prompt, message history). |
| `src/camel/model_backend.ts` | Sends requests to vLLM, applies dynamic model routing. |
| `src/chatdev/skills.ts` | Loads skills from `antigravity-awesome-skills` via TF-IDF. |
| `src/chatdev/tools.ts` | Parses `<tool_call>` XML from model output; routes to actual tools. |
| `src/tools/delegate_to_expert.ts` | Creates isolated sub-agents for specific expertise. |
| `src/tools/web_search.ts` | Queries Perplexica or other search API. |
| `resources/chat.html` | The interactive frontend for agent communication. |
| `RoleConfig.json` | Declares roles, context, and preferred skills. |
| `workspace/` | Shared workspace folder where agents read and write files. |

## Dynamic Pipeline & Complexity Analysis

The system intercepts the task execution (`extension.ts`) before building the `ChatChain`. It queries the `Chief Executive Officer` model (using `mistral` for ultra-fast response) with the user's idea to return a JSON object.

**The CEO determines:**

1. **Phases:** A JSON array of strictly necessary stages (e.g., `["System Architecture", "Coding", "Documentation"]`).
2. **Complexity:** `"Low"` or `"High"`.

This allows the system to bypass unnecessary work (like `Database Optimization` for a simple UI) and intelligently select the best model for the task's difficulty.

## Terminating Feedback Loops

To prevent infinite dialogue loops (e.g., between the Programmer and Code Reviewer), `Phase.ts` dynamically injects a `<DONE>` instruction into the system prompts. The execution explicitly breaks out of the loop immediately after either the assistant or the user agent produces the `<DONE>` marker, ensuring token efficiency and prompt progression.

## Human-in-the-Loop Flow

```text
User Input → Phase 1 (CEO Analysis)
    ↓
[HITL Pause] → "Review Plan" prompt in VS Code.
    ├─ User provides feedback? → Reinjected into context for Phase 2.
    └─ User provides no feedback → Continue.
    ↓
Phase 2 (Architecture) → Phase 3 (Security)
    ↓
Phase 4 (Coding) → HITL Code Review (Optional) → Phase 5 (Docs)
```

## Real-time Streaming UI

To ensure a smooth user experience, all agent responses are streamed to the WebView in real-time.

- **Mechanism:** The `ModelBackend` uses `stream: true` and forwards tokens via `AgentEvent` (`answer_stream_chunk`).
- **Visuals:** Tokens are rendered as they arrive, accompanied by a blinking cursor and a generation indicator 🟢.
- **Benefit:** Eliminates the "frozen" feeling during long generations.

## How Skills Are Loaded

1. `autoLoadSkillsForTask(role + task)` is called before each phase starts.
2. The skills directory (`C:\Users\ITYURA\Documents\antigravity-awesome-skills`) is scanned.
3. Top 3 matching skills are injected into the assistant agent's system prompt.

## Model Routing (Latency-Optimized)

| Role | Model (High Complexity) | Model (Low Complexity) | Description |
|------|-------|-------------|-------------|
| **Chief Executive Officer** | `mistral` | `mistral` | Ultra-fast (0.3s) for task analysis and routing. |
| **Programmer / CTO** | `codestral` | `qwen-code` | Switched to Qwen (0.7s) for simple tasks to save power. |
| **Reviewer / QA / Test** | `qwen-code` | `qwen-code` | High speed and accuracy for logic verification. |
| **Others (Writer/CPO)** | `gemma` | `gemma` | General purpose tasks. |
