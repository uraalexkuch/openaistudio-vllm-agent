# OpenAI_studio_vLLM_Agent — Technical Documentation

## Architecture Overview

This extension implements a **multi-agent software development system** inspired by ChatDev, running entirely locally via a vLLM-compatible backend.

### System Layers

```text
┌──────────────────────────────────────────┐
│              VS Code Extension UI         │
│         (Webview: chat_webview.ts)        │
├──────────────────────────────────────────┤
│        Chat Chain DAG Orchestrator        │
│    (chat_chain.ts + phase.ts + memory.ts) │
│                                          │
│  Phase 1: DAG Analysis (CEO / Gemma)     │
│       ↓                                  │
│  [Parallel Phase Launch] ⚡              │
│  Phase A (CTO) ──┬──► Phase C (QA)       │
│  Phase B (DB)  ──┘                       │
│       ↓                                  │
│  Summarization Agent (CPO / Gemma)       │
├──────────────────────────────────────────┤
│             Agent Communication Layer     │
│  (chat_agent.ts + model_backend.ts)      │
│                                          │
│  ┌─────────────────┐  ┌───────────────┐  │
│  │  Model Routing  │  │  Skill Loader │  │
│  │  Dynamic/Nginx  │  │  TF-IDF Match │  │
│  └─────────────────┘  └───────────────┘  │
├──────────────────────────────────────────┤
│         Tool System (tools.ts)            │
│  read_file | write_file | web_search     │
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
| `src/utils/task_intent.ts` | Detects user intent (create vs analyze) and extracts paths. |
| `src/utils/path_utils.ts` | Resolves paths with optional `readOnly` safety bypass for analysis. |
| `resources/chat.html` | The interactive frontend for agent communication. |
| `RoleConfig.json` | Declares roles, context, and preferred skills. |
| `workspace/` | Shared workspace folder where agents read and write files. |

## Dynamic DAG Pipeline & Complexity Analysis

The system intercepts the task execution (`extension.ts`) before building the `ChatChain`. It queries the `Chief Executive Officer` model (using `gemma` for larger context) to analyze the task and return a **Directed Acyclic Graph (DAG)** of phases.

**The CEO determines:**

1. **DAG Graph:** A JSON structure of phases with their roles and `dependsOn` arrays.
2. **Complexity:** `"Low"` or `"High"`.

## Project Analysis & Maintenance Mode

The system intelligently differentiates between creating new projects and analyzing existing ones.

1. **Intent Detection**: `task_intent.ts` identifies keywords like "explain", "fix", or "refactor". 
2. **Workspace Context**: If a folder is open in VS Code, its metadata (path, stack, key files) is automatically gathered by `WorkspaceManager` and provided to the agent.
3. **External Paths**: Absolute paths provided in the task (e.g., `D:\project`) are prioritized and extracted.
4. **Project Analyst Role**: A specialized read-only role that uses `list_files` and `read_file` to explore existing codebases without making changes.

## Intelligent Technical Summarization

To prevent context window overflow (especially with models like Mistral 4k), the system implements a **Summarization Agent (CPO)**:

1. After each phase completes, the full raw output is stored in `Memory` (on-disk log).
2. The `CPO` (using `gemma`) generates a compact technical summary of the phase (key decisions, files, TODOs).
3. Only these summaries are passed as context to subsequent phases in the DAG.

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
| **CEO / Router** | `gemma` | `gemma` | High context (16k) for complex DAG analysis and routing. |
| **Summarizer (CPO)** | `gemma` | `gemma` | Professional summarization and state management. |
| **Programmer / CTO** | `codestral` | `qwen3-coder` | Specialized coding models with 32k context. |
| **Project Analyst** | `gemma` | `gemma` | Read-only exploration and understanding. |
| **Reviewer / QA / Test** | `qwen3-coder` | `qwen3-coder` | Fast (0.7s) logic verification. |
| **Others (Writer)** | `gemma` | `gemma` | General purpose documentation. |

## Robustness & Security

- **Role Alternation:** `VLLMModelBackend` strictly enforces `user`/`assistant` role alternation to satisfy strict model requirements (Mistral 400 errors).
- **Context Safety:** Dynamic token calculation reserves 35% of the context for output and applies safety truncation for extremely large inputs.
- **Fail-safe Fallback:** If dynamic DAG analysis fails, the system automatically falls back to a predefined static sequential pipeline.

## Multi-language Support

The system dynamically determines the language for agent responses using a three-tiered priority system:

1.  **Explicit Setting**: User-defined `openaistudio.uiLanguage` in VS Code settings.
2.  **Task Detection**: Automatic detection based on the character sets (Cyrillic, Latin, etc.) used in the initial task description.
3.  **Fallback**: VS Code's interface language (`vscode.env.language`) or English.

**Language Enforcement:**
A `LANGUAGE RULE` is injected into the system prompt of every agent. This rule informs the agent that while they can reason internally in any language, the **final response** must be in the target language. This ensures consistency across different roles in the DAG.

Supported languages currently include: **Ukrainian, English, German, French, and Polish**.
