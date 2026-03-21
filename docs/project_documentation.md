# OpenAI_studio_vLLM_Agent — Technical Documentation

## Architecture Overview

This extension implements a **multi-agent software development system** inspired by ChatDev,
running entirely locally via a vLLM-compatible backend.

### System Layers

```
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
│  read_file                               │
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

## Human-in-the-Loop Flow

```
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


## How Skills Are Loaded

1. `autoLoadSkillsForTask(role + task)` is called before each phase starts.
2. The skills directory (`C:\Users\ITYURA\Documents\antigravity-awesome-skills`) is scanned.
3. All `SKILL.md` files are tokenized and scored using TF-IDF against the combined `role + task` query.
4. Top 3 matching skills are injected into the assistant agent's system prompt.
5. The agent then uses these skills as domain-specific instructions.

## Model Routing

| Role | Model | Description |
|------|-------|-------------|
| Programmer, CTO | `codestral` | Optimized for generation and technical design. |
| Reviewer, QA, Test | `qwen-code` | Optimized for logic verification and test suites. |
| CEO, CPO, CCO, Others | `default` | General purpose tasks and strategy. |

