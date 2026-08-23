import type {
	ModelRuntime,
	ResolveModelScopeResult,
} from "@earendil-works/pi-coding-agent";

export interface EnabledModelsSource {
	getEnabledModels(): string[] | undefined;
}

export type ModelScopeResolver = (
	patterns: string[],
	modelRuntime: ModelRuntime,
) => Promise<ResolveModelScopeResult>;

export async function resolveConfiguredModelScope(
	settingsManager: EnabledModelsSource,
	modelRuntime: ModelRuntime,
	resolveModelScope: ModelScopeResolver,
): Promise<ResolveModelScopeResult> {
	const patterns = settingsManager.getEnabledModels() ?? [];
	if (patterns.length === 0) {
		return { scopedModels: [], diagnostics: [] };
	}
	return resolveModelScope(patterns, modelRuntime);
}