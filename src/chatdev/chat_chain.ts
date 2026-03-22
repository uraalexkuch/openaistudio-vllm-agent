// Copyright (c) 2026 Юрій Кучеренко.
import { Phase } from "./phase";
import * as vscode from "vscode";
import { AgentEvent } from "../camel/typing";
import { Memory } from "./memory";
import { VLLMModelBackend } from "../camel/model_backend";
import * as path from "path";
import * as fs from "fs";
import { resolveUiLanguage, buildLanguageRule } from '../utils/language_utils';

export interface PhaseDef {
    phase: Phase;
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
    private async summarise(phaseName: string, rawResult: string, taskPrompt?: string): Promise<string> {
        if (rawResult.length < 400) return rawResult;
        try {
            const summariser = new VLLMModelBackend("Chief Product Officer");
            const langRule = buildLanguageRule(resolveUiLanguage(taskPrompt));
            
            // Для Project Analyst — зберігати конкретні шляхи файлів
            const isAnalystPhase = phaseName.toLowerCase().includes('analys') || 
                                   phaseName.toLowerCase().includes('understanding');
            const extraInstruction = isAnalystPhase 
                ? `IMPORTANT: Include ALL file paths found (exact paths like d:\\project\\src\\file.ts). Next phases need these paths to work.`
                : `Cover: key decisions, files created/modified (exact names), TODOs.`;

            const prompt = [
                `Summarise the "${phaseName}" phase. Max 300 words.`,
                extraInstruction,
                `Output ONLY the summary — no preamble, no markdown fences.`,
                langRule,
                ``,
                `=== PHASE OUTPUT ===`,
                rawResult.slice(0, 6000),
                `=== END ===`,
            ].join("\n");
            const summary = await summariser.step([{ role: "user", content: prompt }], 0.1);
            return summary.trim() || rawResult.slice(0, 500);
        } catch (e) {
            console.warn(`[SummaryAgent] Failed to summarise ${phaseName}:`, e);
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

        const completedSummaries: Record<string, string> = {};
        const savedFiles: string[] = []; // track filenames written by agents
        const done      = new Set<string>();
        const inFlight  = new Set<string>();

        // workspace path fix: __dirname is dist/, so workspace is one level up
        const logDir  = path.resolve(path.join(__dirname, "..", "workspace"));
        const logPath = path.join(logDir, "execution_log.txt");
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

        const buildContext = () => {
            const parts = Object.entries(completedSummaries)
                .map(([name, summary]) => `[${name}]:\n${summary}`)
                .join("\n\n");

            // Tell subsequent phases which files exist in workspace
            const fileHint = savedFiles.length > 0
                ? `\nFILES IN WORKSPACE: ${savedFiles.join(', ')}\n` +
                `(Code Reviewer: use read_file to inspect these files)`
                : '';

            return parts
                ? `=== SUMMARIES OF COMPLETED PHASES ===\n${parts}${fileHint}\n\n=== TASK ===\n${taskPrompt}`
                : taskPrompt;
        };

        const runPhase = async (pd: PhaseDef): Promise<void> => {
            const { phase } = pd;
            inFlight.add(phase.phaseName);

            // FIX: each parallel phase gets its OWN onEvent wrapper that
            // tags events with the phase name — prevents token stream interleaving in UI
            phase.onEvent = (ev) => {
                this.onEvent?.({ ...ev, _phase: phase.phaseName });
            };

            vscode.window.showInformationMessage(`Starting phase: ${phase.phaseName}`);
            this.onEvent?.({ type: "narration", content: `🔷 Фаза: ${phase.phaseName}` });

            const context = buildContext();
            
            try {
                // FIX: Phase timeout (5 minutes) to prevent getting stuck
                const phaseTimeoutLimit = 5 * 60 * 1000;
                const rawResult = await Promise.race([
                    phase.execute(context),
                    new Promise<string>((_, reject) => 
                        setTimeout(() => reject(new Error(`Phase "${phase.phaseName}" timed out after 5m`)), phaseTimeoutLimit)
                    )
                ]);

                this.memory.append(`\n=== PHASE: ${phase.phaseName} ===\n${rawResult}`);
                try { this.memory.saveMemory(logPath); } catch {}

                this.onEvent?.({ type: "narration", content: `📝 Підсумовую фазу: ${phase.phaseName}…` });
                const summary = await this.summarise(phase.phaseName, rawResult, taskPrompt);

                completedSummaries[phase.phaseName] = summary;
                this.chatEnv[`${phase.phaseName}_output`]  = rawResult;
                this.chatEnv[`${phase.phaseName}_summary`] = summary;

                // Extract filenames from tool results so next phases know what exists
                const fileMatches = rawResult.match(/File "([^"]+)" saved successfully/gi) || [];
                for (const m of fileMatches) {
                    const fn = m.match(/File "([^"]+)"/i)?.[1];
                    if (fn && !savedFiles.includes(fn)) savedFiles.push(fn);
                }

                done.add(phase.phaseName);
            } finally {
                inFlight.delete(phase.phaseName);
            }
        };

        const remaining = [...this.phaseDefs];

        while (remaining.length > 0) {
            const ready = remaining.filter(pd =>
                pd.dependsOn.every(dep => done.has(dep)) &&
                !inFlight.has(pd.phase.phaseName)
            );

            if (ready.length === 0) {
                if (inFlight.size > 0) {
                    throw new Error("DAG deadlock: no ready phases but some still in-flight.");
                }
                const stuck = remaining.map(pd => pd.phase.phaseName).join(", ");
                throw new Error(`DAG deadlock: circular or missing dependency for: ${stuck}`);
            }

            for (const pd of ready) {
                remaining.splice(remaining.indexOf(pd), 1);
            }

            if (ready.length === 1) {
                await runPhase(ready[0]);
            } else {
                // FIX: parallel phases run concurrently BUT each has its own streaming
                // context — tokens are tagged with _phase so UI can separate them
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