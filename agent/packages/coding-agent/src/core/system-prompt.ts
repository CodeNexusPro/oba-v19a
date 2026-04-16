/**
 * oba-v19a — basic system prompt builder.
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

const TAU_SCORING_PREAMBLE = `You are a coding assistant. Read files, understand the task, and make edits.

## Rules
- Read before editing
- Make minimal changes
- Match existing code style

---

`;

export interface BuildSystemPromptOptions {
	customPrompt?: string;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	appendSystemPrompt?: string;
	cwd?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Skill[];
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt, selectedTools, toolSnippets, promptGuidelines,
		appendSystemPrompt, cwd, contextFiles: providedContextFiles, skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");
	const date = new Date().toISOString().slice(0, 10);
	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE + customPrompt;
		if (appendSection) prompt += appendSection;
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) prompt += formatSkillsForPrompt(skills);
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;
		return prompt;
	}

	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList = visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";
	const guidelinesList: string[] = [];
	for (const g of promptGuidelines ?? []) { const n = g.trim(); if (n.length > 0) guidelinesList.push(n); }
	guidelinesList.push("Be concise in your responses");
	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = TAU_SCORING_PREAMBLE + `You are a coding assistant.\n\nAvailable tools:\n${toolsList}\n\nGuidelines:\n${guidelines}`;
	if (appendSection) prompt += appendSection;
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}
	const hasRead = tools.includes("read");
	if (hasRead && skills.length > 0) prompt += formatSkillsForPrompt(skills);
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;
	return prompt;
}
