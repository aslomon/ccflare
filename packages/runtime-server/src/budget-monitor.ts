import { Logger } from "@ccflare/logger";
import type { BudgetControl } from "@ccflare/proxy";
import type { Account, BudgetProfile, QuotaSnapshot } from "@ccflare/types";

const log = new Logger("BudgetMonitor");
const weekMs = 7 * 86_400_000;
export class BudgetMonitor {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running: Promise<void> | null = null;
	private stopped = false;
	constructor(
		private readonly control: BudgetControl,
		private readonly readQuota: (
			account: Account,
			profile: BudgetProfile,
		) => Promise<QuotaSnapshot>,
	) {}
	start(): void {
		this.control.refresh = () => this.tick(true);
		this.timer = setInterval(() => void this.tick(), 30_000);
		this.timer.unref();
		void this.tick();
	}
	async dispose(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		await this.running;
	}
	tick(force = false): Promise<void> {
		if (this.running) return this.running;
		if (this.stopped || !this.control.enabled) return Promise.resolve();
		this.running = this.checkAccounts(force)
			.catch(() => {
				log.error("Budget monitor could not read persisted account state");
			})
			.finally(() => {
				this.running = null;
			});
		return this.running;
	}
	private async checkAccounts(force: boolean): Promise<void> {
		const checked = new Set<string>();
		for (const account of this.control.dbOps.getAllAccounts()) {
			if (this.stopped) break;
			if (account.paused || this.control.profile(account).mode === "local")
				continue;
			const group = this.control.group(account);
			if (checked.has(group)) continue;
			checked.add(group);
			const state = this.control.repo.state(group);
			if (!force && state.nextCheckAt > Date.now()) continue;
			await this.checkAccount(account, group);
		}
	}
	private async checkAccount(account: Account, group: string): Promise<void> {
		try {
			const quota = await this.read(account);
			if (this.stopped) return;
			const fresh = this.control.dbOps.getAccount(account.id);
			if (!fresh || this.control.group(fresh) !== group) return;
			this.control.observe(fresh, quota);
			this.scheduleNext(fresh, group);
		} catch (error) {
			if (!this.stopped) this.recordFailure(account, group, error);
		}
	}
	private scheduleNext(account: Account, group: string): void {
		const view = this.control.view(account);
		const next = this.control.repo.state(group);
		const near =
			(view.weeklyUsed ?? 0) >= this.control.policy.cutoffPercent - 10 ||
			view.pacing.balancePercent < 0 ||
			view.reservedPercent >
				Math.max(0.25, view.pacing.ratePercentPerHour / 6) ||
			(view.quota?.windows.find((window) => window.key === "five_hour")
				?.usedPercent ?? 0) >=
				this.control.policy.shortWindowCutoffPercent - 10;
		const reset =
			view.resetAt !== null
				? Math.max(Date.now() + 60_000, view.resetAt + 10_000)
				: Infinity;
		this.control.repo.saveState(group, {
			...next,
			nextCheckAt: Math.min(
				Date.now() + (near ? 60_000 : this.control.policy.pollMs),
				reset,
			),
		});
	}
	private recordFailure(account: Account, group: string, error: unknown): void {
		const code =
			error instanceof Error &&
			/^usage_(parse_(weekly_missing|invalid|snapshot_invalid)|http_\d+|adapter_missing|price_unknown|money_profile_missing|no_credential|provider_missing)$/.test(
				error.message,
			)
				? error.message
				: "usage_check_failed";
		const latest = this.control.repo.state(group);
		const failures = latest.failures + 1;
		this.control.repo.saveState(group, {
			...latest,
			error: code,
			failures,
			nextCheckAt:
				Date.now() + Math.min(1_800_000, 60_000 * 2 ** Math.min(failures, 5)),
		});
		log.warn(`Quota check unavailable for ${account.name}: ${code}`);
		this.control.repo.telemetry.append({
			kind: "failure",
			observedAt: Date.now(),
			accountId: account.id,
			groupId: group,
			model: null,
			reason: code,
			quota: null,
			reservedPercent: this.control.repo.reservedPercent(group, Date.now()),
			actualWorkTotal: latest.actualWorkTotal,
			balancePercent: latest.pacing.balancePercent,
			ratePercentPerHour: latest.pacing.ratePercentPerHour,
			deadline: null,
		});
	}
	private async read(account: Account): Promise<QuotaSnapshot> {
		const profile = this.control.profile(account);
		if (profile.mode === "money") return this.moneyQuota(account);
		return this.readQuota(account, profile);
	}
	private moneyQuota(account: Account): QuotaSnapshot {
		const profile = this.control.profile(account);
		const now = Date.now();
		if (!profile.weeklyUsd || !profile.weekAnchor || profile.weekAnchor > now)
			throw new Error("usage_money_profile_missing");
		const start =
			profile.weekAnchor +
			Math.floor((now - profile.weekAnchor) / weekMs) * weekMs;
		const group = this.control.group(account);
		const ids = this.control.dbOps
			.getAllAccounts()
			.filter((a) => this.control.group(a) === group)
			.map((a) => a.id);
		const usage = this.control.repo.moneyUsage(ids, start, now);
		if (usage.unknown) throw new Error("usage_price_unknown");
		return {
			observedAt: now,
			source: "local-cost",
			windows: [
				{
					key: "seven_day",
					usedPercent: (usage.total / profile.weeklyUsd) * 100,
					resetAt: start + weekMs,
					model: null,
				},
			],
		};
	}
}
