import type { BudgetState, BudgetUsage, BudgetWorkModel } from "@ccflare/types";

function boundedModels(
	models: Record<string, BudgetWorkModel>,
): Record<string, BudgetWorkModel> {
	const keys = Object.keys(models).sort(
		(a, b) => models[b].lastSampleAt - models[a].lastSampleAt,
	);
	return Object.fromEntries(
		keys.slice(0, 64).map((name) => [name, models[name]]),
	);
}

export function measuredWork(usage: BudgetUsage): number | null {
	const values = [
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadInputTokens,
		usage.cacheCreationInputTokens,
		usage.reasoningTokens,
	];
	if (values.every((value) => value === null)) return null;
	const input =
		(usage.inputTokens ?? 0) +
		(usage.cacheCreationInputTokens ?? 0) * 1.25 +
		(usage.cacheReadInputTokens ?? 0) * 0.1;
	// Reasoning is often included in the reported output count already.
	const output =
		Math.max(usage.outputTokens ?? 0, usage.reasoningTokens ?? 0) * 4;
	return Math.max(0.0001, (input + output) / 20_000);
}
export function predictedWork(
	state: BudgetState,
	model: string | null,
	maximumWork: number,
): number {
	const fit =
		model && Object.hasOwn(state.workModels, model)
			? state.workModels[model]
			: undefined;
	if (!fit || fit.samples < 8) return maximumWork;
	return (
		maximumWork * Math.min(2, Math.max(0.03, fit.upperRatio, fit.ratio * 1.5))
	);
}
export function learnWork(
	state: BudgetState,
	model: string | null,
	estimated: number,
	actual: number,
	now: number,
): BudgetState {
	const named = model ?? "unknown";
	const key =
		Object.keys(state.modelWorkTotal).length < 128 ||
		Object.hasOwn(state.modelWorkTotal, named)
			? named
			: "unknown";
	const fit = fitWorkModel(state.workModels, key, estimated, actual, now);
	const workModels = { ...state.workModels, [key]: fit };
	return {
		...state,
		actualWorkTotal: state.actualWorkTotal + actual,
		modelWorkTotal: {
			...state.modelWorkTotal,
			[key]:
				(Object.hasOwn(state.modelWorkTotal, key)
					? state.modelWorkTotal[key]
					: 0) + actual,
		},
		workModels: boundedModels(workModels),
	};
}

function fitWorkModel(
	models: Record<string, BudgetWorkModel>,
	key: string,
	estimated: number,
	actual: number,
	now: number,
): BudgetWorkModel {
	const previous = Object.hasOwn(models, key) ? models[key] : undefined;
	const ratio = Math.max(
		0.0001,
		Math.min(10, actual / Math.max(estimated, 0.0001)),
	);
	return {
		ratio: previous ? previous.ratio * 0.8 + ratio * 0.2 : ratio,
		upperRatio: Math.max(
			ratio * 1.5,
			(previous?.upperRatio ?? ratio * 2) * 0.98,
		),
		samples: (previous?.samples ?? 0) + 1,
		lastSampleAt: now,
	};
}
