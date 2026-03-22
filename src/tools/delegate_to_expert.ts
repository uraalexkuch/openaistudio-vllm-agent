// Copyright (c) 2026 Юрій Кучеренко.
import { ChatAgent } from "../camel/chat_agent";
import { RoleType } from "../camel/typing";
import { autoLoadSkillsForTask } from "../chatdev/skills";

export async function delegate_to_expert(expert_role: string, task_description: string): Promise<string> {
    console.log(`Delegating to expert: ${expert_role}. Task: ${task_description}`);

    // Отримуємо релевантні навички (skills) для субагента (через парсинг SKILL.md)
    const loadedSkills = await autoLoadSkillsForTask(`${expert_role} ${task_description}`);
    const skillsText = loadedSkills.length > 0 ? `\n\n=== АКТУАЛЬНІ НАВИЧКИ (SKILLS) ===\n${loadedSkills.map(s => `[${s.name}]:\n${s.content}`).join('\n\n')}\n==================================\n` : '';

    // Create a temporary subagent to solve the task
    const subAgent = new ChatAgent(
        expert_role, 
        RoleType.ASSISTANT, 
        `Ти експерт штучного інтелекту зі спеціалізацією: ${expert_role}. Твоя мета - детально вирішити конкретне завдання, делеговане основним агентом.
Відповідай виключно УКРАЇНСЬКОЮ мовою. Використовуй наведені нижче навички (якщо вони актуальні) для забезпечення найкращої якості роботи:
${skillsText}`
    );

    const result = await subAgent.step(task_description);
    return `[Delegation Result from ${expert_role}]:\n${result}`;
}
