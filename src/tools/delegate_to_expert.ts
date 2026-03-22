import { ChatAgent } from "../camel/chat_agent";
import { RoleType } from "../camel/typing";
import { autoLoadSkillsForTask } from "../chatdev/skills";
import { resolveUiLanguage, buildLanguageRule } from "../utils/language_utils";

export async function delegate_to_expert(expert_role: string, task_description: string): Promise<string> {
    console.log(`Delegating to expert: ${expert_role}. Task: ${task_description}`);

    const lang = resolveUiLanguage(task_description);
    const langRule = buildLanguageRule(lang);

    // Отримуємо релевантні навички (skills) для субагента (через парсинг SKILL.md)
    const loadedSkills = await autoLoadSkillsForTask(`${expert_role} ${task_description}`);
    const skillsText = loadedSkills.length > 0 ? `\n\n=== АКТУАЛЬНІ НАВИЧКИ (SKILLS) ===\n${loadedSkills.map((s: any) => `[${s.name}]:\n${s.content}`).join('\n\n')}\n==================================\n` : '';

    // Create a temporary subagent to solve the task
    const subAgent = new ChatAgent(
        expert_role, 
        RoleType.ASSISTANT, 
        `You are an AI expert specialising in: ${expert_role}. ` +
        `Your goal is to solve the delegated task in detail.\n\n${langRule}\n\n` +
        `Use the following skills (if relevant) to ensure top quality:\n${skillsText}`
    );

    const result = await subAgent.step(task_description);
    return `[Delegation Result from ${expert_role}]:\n${result}`;
}
