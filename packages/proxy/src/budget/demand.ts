import type { Account } from "@ccflare/types";
import type { BudgetControl } from "./control";

export function poolDemand(
	control: BudgetControl,
	pool: Account[],
	now: number,
) {
	const started = pool
		.map(
			(account) => control.repo.state(control.group(account)).trackingStartedAt,
		)
		.filter((time) => time > 0);
	const coverageMs = started.length
		? Math.max(0, now - Math.min(...started))
		: 0;
	const ids = pool.map((account) => account.id);
	const recentHours = Math.max(1 / 60, Math.min(1, coverageMs / 3_600_000));
	const baselineHours = Math.max(1 / 60, Math.min(6, coverageMs / 3_600_000));
	const recentWorkPerHour =
		control.repo.telemetry.workSince(ids, now - recentHours * 3_600_000) /
		recentHours;
	const baselineWorkPerHour =
		control.repo.telemetry.workSince(ids, now - baselineHours * 3_600_000) /
		baselineHours;
	return {
		coverageMs,
		recentWorkPerHour,
		baselineWorkPerHour,
		poolDemandPerHour: recentWorkPerHour * 0.65 + baselineWorkPerHour * 0.35,
	};
}
