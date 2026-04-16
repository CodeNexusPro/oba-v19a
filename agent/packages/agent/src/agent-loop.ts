/**
 * oba-v19a agent loop — basic implementation.
 * Simple tool-call cycle without advanced steering.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();
	void runAgentLoop(prompts, context, config, async (event) => { stream.push(event); }, signal, streamFn)
		.then((messages) => { stream.end(messages); });
	return stream;
}

export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) throw new Error("Cannot continue: no messages in context");
	if (context.messages[context.messages.length - 1].role === "assistant") throw new Error("Cannot continue from message role: assistant");
	const stream = createAgentStream();
	void runAgentLoopContinue(context, config, async (event) => { stream.push(event); }, signal, streamFn)
		.then((messages) => { stream.end(messages); });
	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = { ...context, messages: [...context.messages, ...prompts] };
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}
	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) throw new Error("Cannot continue: no messages in context");
	if (context.messages[context.messages.length - 1].role === "assistant") throw new Error("Cannot continue from message role: assistant");
	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

// Basic loop — no steering, no time management, exits early
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];
	const loopStart = Date.now();
	// Simple timeout — exit after 60s to be safe
	const GRACEFUL_EXIT_MS = 60_000;

	while (true) {
		let hasMoreToolCalls = true;

		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "aborted" || message.stopReason === "error") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				toolResults.push(...(await executeToolCalls(currentContext, message, config, signal, emit)));
				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}

				// Exit early if time is up
				if ((Date.now() - loopStart) >= GRACEFUL_EXIT_MS) {
					await emit({ type: "turn_end", message, toolResults });
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}
			}

			await emit({ type: "turn_end", message, toolResults });
			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}
	const llmMessages = await config.convertToLlm(messages);
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};
	const streamFunction = streamFn || streamSimple;
	const resolvedApiKey = (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	const response = await streamFunction(config.model, llmContext, { ...config, apiKey: resolvedApiKey, signal });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;
			case "text_start": case "text_delta": case "text_end":
			case "thinking_start": case "thinking_delta": case "thinking_end":
			case "toolcall_start": case "toolcall_delta": case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({ type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } });
				}
				break;
			case "done": case "error": {
				const finalMessage = await response.result();
				if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
				else context.messages.push(finalMessage);
				if (!addedPartial) await emit({ type: "message_start", message: { ...finalMessage } });
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
	else { context.messages.push(finalMessage); await emit({ type: "message_start", message: { ...finalMessage } }); }
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const toolCalls: AgentToolCall[] = assistantMessage.content
		.filter((c) => c.type === "toolCall")
		.map((c) => c as AgentToolCall);
	const results: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		const tool = currentContext.tools?.find((t: any) => t.definition?.name === toolCall.name) as AgentTool | undefined;
		if (!tool) {
			const result: ToolResultMessage = {
				role: "toolResult",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				content: [{ type: "text", text: `Tool '${toolCall.name}' not found.` }],
				isError: true,
				timestamp: Date.now(),
			};
			await emit({ type: "tool_start", toolCall, tool: undefined });
			await emit({ type: "tool_end", toolCall, result, tool: undefined });
			results.push(result);
			continue;
		}
		const validatedArgs = validateToolArguments(tool.definition, toolCall.arguments);
		await emit({ type: "tool_start", toolCall, tool });
		let result: AgentToolResult;
		try {
			result = await tool.execute(validatedArgs, { signal, emit, toolCall, context: currentContext, config });
		} catch (error: any) {
			result = {
				content: [{ type: "text", text: `Tool execution error: ${error?.message || String(error)}` }],
				isError: true,
			};
		}
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			content: result.content,
			isError: result.isError || false,
			timestamp: Date.now(),
		};
		await emit({ type: "tool_end", toolCall, result: toolResult, tool });
		results.push(toolResult);
	}
	return results;
}
