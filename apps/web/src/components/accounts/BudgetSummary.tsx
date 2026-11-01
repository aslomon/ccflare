import type { BudgetAccountView } from "@ccflare/types";
import { Badge } from "../ui/badge";
import { Progress } from "../ui/progress";

const percentage = (value: number | null) =>
	value === null ? "Unknown" : `${value.toFixed(1)}%`;
const date = (value: number | null) =>
	value === null ? "Not started" : new Date(value).toLocaleString();
function BudgetFacts({ budget }: { budget: BudgetAccountView }) {
	const short = budget.quota?.windows.find(
		(window) => window.key === "five_hour",
	);
	return (
		<div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
			<span>Weekly reset: {date(budget.resetAt)}</span>
			<span>5-hour usage: {percentage(short?.usedPercent ?? null)}</span>
			<span>
				Usage checked:{" "}
				{budget.quota ? date(budget.quota.observedAt) : "Awaiting provider"}
			</span>
			<span>
				Switch by: {date(budget.deadline)} · earlier if allowance is spent
			</span>
			<span>
				Safe weekly pace:{" "}
				{budget.pacing?.ratePercentPerHour.toFixed(2) ?? "Unknown"} percentage
				points/hour
			</span>
			<span>Reserved usage: {percentage(budget.reservedPercent ?? null)}</span>
		</div>
	);
}

function BudgetForecast({ budget }: { budget: BudgetAccountView }) {
	const forecast = budget.forecast;
	return (
		<div className="space-y-1 text-xs text-muted-foreground">
			<p>
				Estimated at reset: {percentage(budget.predictedAtReset)} with current
				pool demand
			</p>
			<p>
				Forecast confidence: {forecast?.confidence ?? "unknown"} · consumption{" "}
				{budget.learning ? "learning" : "calibrated"}
			</p>
			{forecast?.poolDeficit && (
				<p className="text-warning">
					Current demand exceeds this pool's estimated sustainable capacity.
				</p>
			)}
			{budget.pacing?.balancePercent < 0 && (
				<p className="text-warning">
					Burst allowance spent; traffic moves to compatible accounts with more
					room.
				</p>
			)}
		</div>
	);
}

function LocalCapacitySummary({ budget }: { budget: BudgetAccountView }) {
	return (
		<div className="space-y-2 border-t pt-3 text-sm">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span>Local inference · $0 variable API fees</span>
				<Badge variant={budget.eligible ? "secondary" : "destructive"}>
					{budget.reason.replaceAll("_", " ")}
				</Badge>
			</div>
			<p className="text-xs text-muted-foreground">
				No weekly quota. Up to two concurrent requests across the local
				provider. Server and model availability are checked when dispatched.
			</p>
		</div>
	);
}

export function BudgetSummary({ budget }: { budget: BudgetAccountView }) {
	if (budget.profile.mode === "local")
		return <LocalCapacitySummary budget={budget} />;
	return (
		<div className="space-y-2 border-t pt-3 text-sm">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span>
					Weekly usage <strong>{percentage(budget.weeklyUsed)}</strong> /{" "}
					{budget.cutoffPercent}% cutoff
				</span>
				<Badge variant={budget.eligible ? "secondary" : "destructive"}>
					{budget.reason.replaceAll("_", " ")}
				</Badge>
			</div>
			{budget.weeklyUsed !== null && (
				<Progress
					aria-label="Weekly usage"
					value={Math.min(100, budget.weeklyUsed)}
				/>
			)}
			<BudgetFacts budget={budget} />
			<BudgetForecast budget={budget} />
			{budget.quota?.source === "local-cost" && (
				<p className="text-xs text-warning">
					Local estimated spend; external API usage is excluded.
				</p>
			)}
		</div>
	);
}
