import { describe, expect, it, vi } from "vitest";
import {
	resolveConfiguredModelScope,
	type ModelScopeResolver,
} from "../model-scope";

describe("resolveConfiguredModelScope", () => {
	it("resolves configured patterns against the refreshed model runtime", async () => {
		const model = { id: "model-a", provider: "provider-a" };
		const resolveModelScope = vi.fn<ModelScopeResolver>().mockResolvedValue({
			scopedModels: [{ model } as never],
			diagnostics: [],
		});
		const settingsManager = {
			getEnabledModels: () => ["provider-a/model-a"],
		};
		const modelRuntime = {} as never;

		const result = await resolveConfiguredModelScope(
			settingsManager,
			modelRuntime,
			resolveModelScope,
		);

		expect(resolveModelScope).toHaveBeenCalledWith(
			["provider-a/model-a"],
			modelRuntime,
		);
		expect(result.scopedModels).toHaveLength(1);
		expect(result.scopedModels[0]?.model).toBe(model);
	});

	it("returns an empty scope when no models are configured", async () => {
		const resolveModelScope = vi.fn<ModelScopeResolver>();
		const result = await resolveConfiguredModelScope(
			{ getEnabledModels: () => [] },
			{} as never,
			resolveModelScope,
		);

		expect(result).toEqual({ scopedModels: [], diagnostics: [] });
		expect(resolveModelScope).not.toHaveBeenCalled();
	});
});