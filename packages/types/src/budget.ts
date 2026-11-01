import type { Account } from "./account";

export interface BudgetPolicy {
	enabled: boolean;
	cutoffPercent: number;
	headroomPercent: number;
	shortWindowCutoffPercent: number;
	pollMs: number;
	maxAgeMs: number;
	reservationMs: number;
	minSessionMs: number;
	maxSessionMs: number;
}
export interface BudgetProfile {
	mode: "auto" | "claude" | "codex" | "zai" | "grok" | "money" | "local";
	groupId: string | null;
	models: string[];
	weeklyUsd: number | null;
	weekAnchor: number | null;
}
export interface QuotaWindow {
	key: string;
	usedPercent: number;
	resetAt: number | null;
	model: string | null;
}
export interface QuotaSnapshot {
	observedAt: number;
	source:
		| "claude-oauth"
		| "codex-oauth"
		| "zai-coding"
		| "grok-build"
		| "local-cost";
	windows: QuotaWindow[];
}
export interface BudgetWindowLearning {
	resetAt: number | null;
	observedAt: number;
	usedPercent: number;
	workCursor: number;
	costPerWork: number;
	samples: number;
	lastSampleAt: number;
	unattributedPercent: number;
}
export interface BudgetWorkModel {
	ratio: number;
	upperRatio: number;
	samples: number;
	lastSampleAt: number;
}
export interface BudgetPacing {
	updatedAt: number;
	balancePercent: number;
	ratePercentPerHour: number;
	pendingPercent: number;
	observedPercent: number;
}
export interface BudgetUsage {
	requestId: string;
	accountId: string;
	model: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	reasoningTokens: number | null;
	costUsd: number | null;
}
export interface BudgetState {
	quota: QuotaSnapshot | null;
	error: string | null;
	nextCheckAt: number;
	failures: number;
	workTotal: number;
	observedWork: number;
	weeklyCostPerWork: number;
	shortCostPerWork: number;
	weeklyBlockedReset: number | null;
	learnedSamples: number;
	weeklyBurnPerHour: number;
	burnSampleDurationMs: number;
	burnObservedAt: number;
	burnObservedPercent: number;
	actualWorkTotal: number;
	modelWorkTotal: Record<string, number>;
	windowLearning: Record<string, BudgetWindowLearning>;
	workModels: Record<string, BudgetWorkModel>;
	pacing: BudgetPacing;
	trackingStartedAt: number;
}
export interface BudgetDecision {
	eligible: boolean;
	reason: string;
	score: number;
	weeklyUsed: number | null;
	resetAt: number | null;
	predictedAtReset: number | null;
	ageMs: number | null;
}
export interface BudgetAccountView extends BudgetDecision {
	profile: BudgetProfile;
	quota: QuotaSnapshot | null;
	cutoffPercent: number;
	manualPaused: boolean;
	automaticPaused: boolean;
	nextCheckAt: number;
	learning: boolean;
	deadline: number | null;
	reservedPercent: number;
	measuredWork: number;
	pacing: BudgetPacing;
	forecast: {
		confidence: "unknown" | "low" | "medium" | "high";
		coverageMs: number;
		sampleAgeMs: number | null;
		recentWorkPerHour: number;
		baselineWorkPerHour: number;
		poolCapacityPerHour: number;
		poolDemandPerHour: number;
		poolDeficit: boolean;
		expectedPercentPerHour: number;
	};
}
export interface BudgetHistoryFact {
	kind: "quota" | "selection" | "denied" | "failure";
	observedAt: number;
	accountId: string;
	groupId: string;
	model: string | null;
	reason: string;
	quota: QuotaSnapshot | null;
	reservedPercent: number;
	actualWorkTotal: number;
	balancePercent: number;
	ratePercentPerHour: number;
	deadline: number | null;
}
export interface BudgetHistoryQuery {
	accountId?: string;
	before?: number;
	limit: number;
}
export interface BudgetHistoryPage {
	entries: Array<BudgetHistoryFact & { id: number }>;
	nextBefore: number | null;
}
export interface BudgetRouting {
	readonly enabled: boolean;
	order(accounts: Account[], model: string | null, work?: number): Account[];
	reserve(
		account: Account,
		model: string | null,
		work: number,
		percentOverride?: number,
		requestId?: string,
	): string | null;
	bind?(reservationId: string, requestId: string): void;
	finish(reservationId: string): void;
	renew(reservationId: string): void;
	view(
		account: Account,
		model?: string | null,
		work?: number,
	): BudgetAccountView;
}
export interface BudgetManagement extends BudgetRouting {
	policy: BudgetPolicy;
	configure(policy: BudgetPolicy): void;
	setProfile(account: Account, profile: BudgetProfile): void;
	refresh(): Promise<void>;
	history(query: BudgetHistoryQuery): BudgetHistoryPage;
}
