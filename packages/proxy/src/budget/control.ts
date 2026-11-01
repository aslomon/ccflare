import { budgetPolicySchema, decideBudget } from "@ccflare/core";
import type { BudgetRepository, DatabaseOperations } from "@ccflare/database";
import type {
	Account,
	BudgetAccountView,
	BudgetDecision,
	BudgetHistoryQuery,
	BudgetPolicy,
	BudgetProfile,
	BudgetRouting,
	BudgetUsage,
	QuotaSnapshot,
} from "@ccflare/types";
import { admitBudgetRequest } from "./admission";
import { recordCompletedUsage } from "./completion";
import { recordBudgetSwitch } from "./history";
import { previewPacing } from "./pacing";
import { pacedCandidates } from "./pool-pacing";
import { saveBudgetProfile } from "./profile-validation";
import {
	accountOrigin,
	credentialGroup,
	inferBudgetProfile,
	isCodexEndpoint,
	isZaiCodingEndpoint,
	poolKey,
} from "./profiles";
import { recordQuotaObservation } from "./quota-observation";
import { orderBudgetSessions, pruneBudgetSession } from "./scheduler";
import { viewBudgetAccount } from "./view";
import { sessionWeights } from "./weights";
import { predictedWork } from "./work";

export class BudgetControl implements BudgetRouting {
	refresh: () => Promise<void> = async () => {};
	constructor(
		readonly dbOps: DatabaseOperations,
		readonly repo: BudgetRepository,
		public policy: BudgetPolicy,
	) {}
	get enabled(): boolean {
		return this.policy.enabled;
	}
	configure(policy: BudgetPolicy): void {
		this.policy = budgetPolicySchema.parse(policy);
	}
	profile(account: Account): BudgetProfile {
		const saved = this.repo.profile(account.id);
		if (saved) {
			if (
				(saved.mode === "claude" &&
					accountOrigin(account) !== "https://api.anthropic.com") ||
				(saved.mode === "zai" && !isZaiCodingEndpoint(account)) ||
				(saved.mode === "codex" && !isCodexEndpoint(account))
			)
				return { ...saved, mode: "auto" };
			return saved;
		}
		const profile = inferBudgetProfile(account);
		const identical = this.dbOps
			.getAllAccounts()
			.find(
				(peer) =>
					peer.id !== account.id &&
					credentialGroup(peer) === credentialGroup(account),
			);
		profile.groupId =
			(identical ? this.repo.profile(identical.id)?.groupId : null) ??
			credentialGroup(account);
		this.repo.saveProfile(account.id, profile);
		return profile;
	}
	group(account: Account): string {
		const profile = this.profile(account);
		return `${profile.mode}:${profile.mode === "money" || profile.mode === "auto" ? accountOrigin(account) : "subscription"}:${profile.groupId ?? account.id}`;
	}
	setProfile(account: Account, value: BudgetProfile): void {
		saveBudgetProfile(this, account, value);
	}
	view(
		account: Account,
		model: string | null = null,
		work = 0,
	): BudgetAccountView {
		return viewBudgetAccount(this, account, model, work);
	}
	decision(
		account: Account,
		model: string | null,
		work: number,
		now: number,
		predict = true,
	): BudgetDecision {
		const group = this.group(account);
		const state = this.repo.state(group);
		const windowReservations = Object.fromEntries(
			(state.quota?.windows ?? [])
				.filter((window) => window.model !== null)
				.map((window) => [
					window.key,
					this.repo.reservedModelWork(group, window.model ?? "", now) *
						(state.windowLearning[window.key]?.costPerWork ??
							state.weeklyCostPerWork),
				]),
		);
		return decideBudget(
			state,
			this.profile(account),
			this.policy,
			now,
			model,
			this.repo.reservedPercent(group, now),
			predict ? predictedWork(state, model, work) : work,
			this.repo.reservedWork(group, now),
			windowReservations,
		);
	}
	private matches(account: Account, model: string | null): boolean {
		const profile = this.profile(account);
		return (
			profile.mode !== "auto" &&
			(!model ||
				profile.models.length === 0 ||
				profile.models.some(
					(pattern) =>
						pattern === model ||
						(pattern.endsWith("*") && model.startsWith(pattern.slice(0, -1))),
				))
		);
	}
	modelPool(
		account: Account,
		model: string | null,
		accounts = this.dbOps.getAllAccounts(),
	): Account[] {
		return accounts.filter(
			(peer) =>
				poolKey(peer) === poolKey(account) &&
				this.matches(peer, model) &&
				!peer.paused,
		);
	}
	compatiblePool(
		account: Account,
		model: string | null,
		accounts = this.dbOps.getAllAccounts(),
		work = 0,
	): Account[] {
		const now = Date.now();
		return this.modelPool(account, model, accounts).filter(
			(peer) =>
				(peer.rate_limited_until ?? 0) <= now &&
				this.decision(peer, model, work, now).eligible,
		);
	}
	hasAllowance(
		account: Account,
		model: string | null,
		work: number,
		now: number,
	): boolean {
		const group = this.group(account);
		const state = this.repo.state(group);
		const pace = previewPacing(
			state,
			this.policy,
			this.repo.reservedPercent(group, now),
			now,
		);
		return (
			pace.balancePercent >=
			predictedWork(state, model, work) * state.weeklyCostPerWork
		);
	}
	order(accounts: Account[], model: string | null, work = 0): Account[] {
		const first = accounts.find((account) => this.matches(account, model));
		if (!first) return [];
		if (this.profile(first).mode === "local")
			return this.compatiblePool(first, model, accounts, work);
		return this.repo.atomic(() =>
			this.selectPool(first, accounts, model, work),
		);
	}
	private selectPool(
		first: Account,
		accounts: Account[],
		model: string | null,
		work: number,
	): Account[] {
		pruneBudgetSession(this.repo, poolKey(first), this.dbOps.getAllAccounts());
		const pool = this.compatiblePool(first, model, accounts, work);
		const { scores, learning } = sessionWeights(this, pool, model);
		const candidates = pacedCandidates(this, pool, model, work);
		const previous = this.repo.session(poolKey(first));
		const reason =
			previous.deadline <= Date.now()
				? "session_deadline"
				: candidates.some((account) => account.id === previous.accountId)
					? "sticky_session"
					: "pace_or_quota_guard";
		const ordered = orderBudgetSessions(
			candidates,
			scores,
			this.repo,
			this.policy,
			learning,
			reason,
		);
		const chosen = ordered[0];
		if (chosen) recordBudgetSwitch(this, chosen, previous, model);
		return [
			...ordered,
			...pool.filter(
				(account) => !ordered.some((item) => item.id === account.id),
			),
		];
	}
	reserve(
		account: Account,
		model: string | null,
		work: number,
		percentOverride?: number,
		requestId?: string,
	): string | null {
		return this.repo.atomic(() => {
			const fresh = this.dbOps.getAccount(account.id);
			if (
				!fresh ||
				fresh.paused ||
				(fresh.rate_limited_until ?? 0) > Date.now()
			)
				return null;
			return admitBudgetRequest(this, {
				account: fresh,
				model,
				maximumWork: work,
				override: percentOverride,
				requestId,
			});
		});
	}
	finish(id: string): void {
		this.repo.finish(id, Date.now());
	}
	renew(id: string): void {
		this.repo.renew(id, Date.now() + this.policy.reservationMs);
	}
	bind(id: string, requestId: string): void {
		this.repo.telemetry.bind(id, requestId);
	}
	recordUsage(usage: BudgetUsage): boolean {
		return this.repo.atomic(() => recordCompletedUsage(this, usage));
	}
	history(query: BudgetHistoryQuery) {
		return this.repo.telemetry.history(query);
	}
	observe(account: Account, quota: QuotaSnapshot): void {
		this.repo.atomic(() => recordQuotaObservation(this, account, quota));
	}
}
