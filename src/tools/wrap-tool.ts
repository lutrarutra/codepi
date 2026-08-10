/**
 * Wrap a tool definition into the AgentTool shape required by
 * `createAgentSession({ baseToolsOverride })`.
 *
 * Kept free of VS Code imports so both the extension host and the bundled
 * extensions (jiti-loaded) can use it. The SDK converts override values back
 * to definitions for its registry; prompt metadata and renderers are
 * forwarded through (see the sdk patch on createToolDefinitionFromAgentTool).
 */
// The SDK does not export `Tool` (the AgentTool shape) from its package root;
// type-only relative import mirrors the typebox deep import in context-tools.ts.
import type { Tool } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js";

export function wrapToolDefinition(definition: {
	name: string;
	label?: string;
	description: string;
	parameters: unknown;
	constrainedSampling?: unknown;
	prepareArguments?: unknown;
	executionMode?: unknown;
	promptSnippet?: unknown;
	promptGuidelines?: unknown;
	renderCall?: unknown;
	renderResult?: unknown;
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	): unknown;
}): Tool {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
		renderCall: definition.renderCall,
		renderResult: definition.renderResult,
		execute: (
			toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: unknown,
		) => definition.execute(toolCallId, params, signal, onUpdate, undefined),
	} as Tool;
}
