import { Phase } from "./phase";
import * as vscode from "vscode";
import { AgentEvent } from "../camel/typing";
import { Memory } from "./memory";
import { VLLMModelBackend } from "../camel/model_backend";
import * as path from "path";

// ── DAG node: a phase plus its declared dependencies ────────────────────────
export interface PhaseDef {
    phase: Phase;
    /** Names of phases that must complete before this one starts. Empty = no deps. */
    dependsOn: string[];
}

export class ChatChain {
    private phaseDefs: PhaseDef[] = [];
    public onEvent?: (ev: AgentEvent) => void;
    private chatEnv: Record<string, string> = {};
    private memory: Memory = new Memory();

    addPhase(phase: Phase, dependsOn: string[] = []) {
        this.phaseDefs.push({ phase, dependsOn });
    }

    // ── SummaryAgent ─────────────────────────────────────────────────────────
    // Compresses a raw phase result into a compact technical summary.
    // The full result is written to disk (Memory); only the summary enters
    // the next phase's context prompt, keeping prompts short.
    private async summarise(phaseName: string, rawResult: string): Promise<string> {
        // Skip summarisation for very short outputs
        if (rawResult.length < 400) return rawResult;

        try {
            const summariser = new VLLMModelBackend("Chief Product Officer"); // gemma
            const prompt = [
                `You are a technical summariser. Read the output of the "${phaseName}" phase below.`,
                `Write a CONCISE technical summary (max 200 words) covering:`,
                `- Key decisions made`,
                `- Files created or modified (with names)`,
                `- Any unresolved issues or TODOs`,
                `- What the next phase needs to know`,
                ``,
                `Do NOT repeat the full content. Output ONLY the summary, no preamble.`,
                ``,
                `=== PHASE OUTPUT ===`,
                rawResult.slice(0, 6000), // cap input to summariser
                `=== END ===`,
            ].join("\n");

            const summary = await summariser.step([{ role: "user", content: prompt }], 0.1);
            return summary.trim() || rawResult.slice(0, 500);
        } catch (e) {
            console.warn(`[SummaryAgent] Failed to summarise ${phaseName}:`, e);
            // Fallback: truncated raw result
            return rawResult.slice(0, 500) + (rawResult.length > 500 ? "\n…(truncated)" : "");
        }
    }

    // ── DAG execution ─────────────────────────────────────────────────────────
    async execute(taskPrompt: string): Promise<Record<string, string>> {
        const planDescription = this.phaseDefs.map((pd, i) => {
            const deps = pd.dependsOn.length ? ` (after: ${pd.dependsOn.join(", ")})` : "";
            return `${i + 1}. ${pd.phase.phaseName}${deps}`;
        }).join("\n");

        this.onEvent?.({ type: "narration", content: `📢 ПЛАН ДІЙ:\n${planDescription}` });

        // Completed phase summaries — this is what subsequent phases receive as context
        const completedSummaries: Record<string, string> = {};
        // Track which phases are done
        const done = new Set<string>();
        // Track which phases are in-flight
        const inFlight = new Set<string>();

        const buildContext = () => {
            const parts = Object.entries(completedSummaries)
                .map(([name, summary]) => `[${name}]:\n${summary}`)
                .join("\n\n");
            return parts
                ? `=== SUMMARIES OF COMPLETED PHASES ===\n${parts}\n\n=== TASK ===\n${taskPrompt}`
                : taskPrompt;
        };

        // Save full history to disk via Memory
        const logDir = path.join(__dirname, "..", "..", "workspace");
        const logPath = path.join(logDir, "execution_log.txt");

        const runPhase = async (pd: PhaseDef): Promise<void> => {
            const { phase } = pd;
            inFlight.add(phase.phaseName);

            phase.onEvent = (ev) => this.onEvent?.(ev);

            vscode.window.showInformationMessage(`Starting phase: ${phase.phaseName}`);
            this.onEvent?.({ type: "narration", content: `🔷 Фаза: ${phase.phaseName}` });

            const context = buildContext();
            const rawResult = await phase.execute(context);

            // Store full output in Memory (disk)
            this.memory.append(`\n=== PHASE: ${phase.phaseName} ===\n${rawResult}`);
            try { this.memory.saveMemory(logPath); } catch {}

            // Summarise for next-phase context
            this.onEvent?.({ type: "narration", content: `📝 Підсумовую фазу: ${phase.phaseName}…` });
            const summary = await this.summarise(phase.phaseName, rawResult);

            completedSummaries[phase.phaseName] = summary;
            this.chatEnv[`${phase.phaseName}_output`] = rawResult;
            this.chatEnv[`${phase.phaseName}_summary`] = summary;

            done.add(phase.phaseName);
            inFlight.delete(phase.phaseName);
        };

        // Iteratively find phases whose dependencies are all met and run them,
        // launching independent phases in parallel via Promise.all.
        const remaining = [...this.phaseDefs];

        while (remaining.length > 0) {
            // Find all phases that are ready right now (deps done, not in-flight)
            const ready = remaining.filter(pd =>
                pd.dependsOn.every(dep => done.has(dep)) &&
                !inFlight.has(pd.phase.phaseName)
            );

            if (ready.length === 0) {
                if (inFlight.size > 0) {
                    // Phases in-flight — this shouldn't happen in sequential await,
                    // but guard against it
                    throw new Error("DAG deadlock: no ready phases but some still in-flight.");
                }
                // Circular dependency or missing dep declaration
                const stuck = remaining.map(pd => pd.phase.phaseName).join(", ");
                throw new Error(`DAG deadlock: circular or missing dependency for: ${stuck}`);
            }

            // Remove ready phases from remaining before launching
            for (const pd of ready) {
                remaining.splice(remaining.indexOf(pd), 1);
            }

            if (ready.length === 1) {
                // Single phase — run sequentially
                await runPhase(ready[0]);
            } else {
                // Multiple independent phases — run in parallel
                const names = ready.map(pd => pd.phase.phaseName).join(", ");
                this.onEvent?.({ type: "narration", content: `⚡ Паралельний запуск: ${names}` });
                await Promise.all(ready.map(pd => runPhase(pd)));
            }
        }

        vscode.window.showInformationMessage("ChatChain Execution Finished.");
        this.onEvent?.({ type: "narration", content: "✅ Всі фази завершено." });
        return this.chatEnv;
    }

    getChatEnv(): Record<string, string> {
        return this.chatEnv;
    }
}