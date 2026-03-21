# Changelog — OpenAI_studio_vLLM_Agent

All notable changes to this extension will be documented here.

---

## [0.0.1] — 2026-03-21

### Added
- Initial version of the extension based on ChatDev architecture.
- Multi-agent pipeline: CTO → DB Expert → Security → Programmer → TechWriter.
- Dynamic skill loading via TF-IDF scoring (from `antigravity-awesome-skills`).
- `save_skill` tool so agents can persist learned patterns to the knowledge base.
- `write_file` / `read_file` tools for cross-phase file sharing via `workspace/`.
- `delegate_to_expert` tool for isolated sub-agent task delegation.
- `web_search` tool for real-time information retrieval.
- Human-in-the-Loop (HITL) interceptor before Coding phase.
- Dynamic `ArchitectureRevision` phase triggered by human feedback.
- Ukrainian language enforced in all agent responses.
- Dynamic model routing: `codestral` for Programmer, `qwen-code` for Reviewer/QA.
