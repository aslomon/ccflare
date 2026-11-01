import { formatCost } from "@ccflare/core";
import type { TimeRange } from "@ccflare/types";
import {
	formatNumber,
	formatPercentage,
	formatTokens,
	formatTokensPerSecond,
} from "@ccflare/ui";
import {
	Activity,
	CheckCircle,
	Clock,
	DollarSign,
	Hash,
	Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { REFRESH_INTERVALS } from "../constants";
import { useAccounts, useAnalytics, useStats } from "../hooks/queries";
import { ChartsSection } from "./overview/ChartsSection";
import { DataRetentionCard } from "./overview/DataRetentionCard";
import { LoadingSkeleton } from "./overview/LoadingSkeleton";
import { MetricCard } from "./overview/MetricCard";
import { OverviewCostDetails } from "./overview/OverviewCostDetails";
import {
	buildOverviewTimeSeries,
	getEstimatedCostNote,
	getOverviewTrends,
	OVERVIEW_DEFAULT_RANGE,
} from "./overview/overview-data";
import { RateLimitInfo } from "./overview/RateLimitInfo";
import { SystemStatus } from "./overview/SystemStatus";
import { TimeRangeSelector } from "./overview/TimeRangeSelector";
import { StrategyCard } from "./StrategyCard";

export function OverviewTab() {
	// Fetch all data using React Query hooks
	const { data: stats, isLoading: statsLoading } = useStats(
		REFRESH_INTERVALS.default,
	);
	const [timeRange, setTimeRange] = useState<TimeRange>(OVERVIEW_DEFAULT_RANGE);
	const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
		timeRange,
		{ accounts: [], models: [], status: "all" },
		"normal",
	);
	const { data: accounts, isLoading: accountsLoading } = useAccounts();

	const loading = statsLoading || analyticsLoading || accountsLoading;
	const combinedData =
		stats && analytics && accounts ? { stats, analytics, accounts } : null;

	// Transform time series data
	const timeSeriesData = useMemo(() => {
		if (!analytics) return [];
		return buildOverviewTimeSeries(analytics.timeSeries, timeRange);
	}, [analytics, timeRange]);

	if (loading && !combinedData) {
		return <LoadingSkeleton />;
	}

	const trends = getOverviewTrends(analytics?.timeSeries ?? [], timeRange);

	// Use analytics data for model distribution
	const modelData =
		analytics?.modelDistribution?.map((model) => ({
			name: model.model || "Unknown",
			value: model.count,
		})) || [];

	// Use analytics data for account health
	const accountHealthData = analytics?.accountPerformance || [];

	return (
		<div className="space-y-6">
			{/* Header with Time Range Selector */}
			<div className="flex justify-between items-center">
				<h2 className="text-2xl font-semibold">Overview</h2>
				<TimeRangeSelector value={timeRange} onChange={setTimeRange} />
			</div>

			<p className="text-xs text-muted-foreground">
				Totals cover the selected range. Trend arrows compare the last two
				complete time buckets.
			</p>

			{/* Metrics Grid */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
				<MetricCard
					title="Total Requests"
					value={formatNumber(analytics?.totals.requests || 0)}
					change={trends.requests?.change}
					trend={trends.requests?.direction ?? "flat"}
					favorable={trends.requests?.favorable}
					trendPeriod={trends.period}
					icon={Activity}
				/>
				<MetricCard
					title="Success Rate"
					value={formatPercentage(analytics?.totals.successRate || 0, 2)}
					change={trends.successRate?.change}
					trend={trends.successRate?.direction ?? "flat"}
					favorable={trends.successRate?.favorable}
					trendPeriod={trends.period}
					icon={CheckCircle}
				/>
				<MetricCard
					title="Avg Response Time"
					value={`${Math.round(analytics?.totals.avgResponseTime || 0)}ms`}
					change={trends.responseTime?.change}
					trend={trends.responseTime?.direction ?? "flat"}
					favorable={trends.responseTime?.favorable}
					trendPeriod={trends.period}
					icon={Clock}
				/>
				<MetricCard
					title="Total Tokens"
					value={formatTokens(analytics?.totals.totalTokens)}
					icon={Hash}
					note="Includes input, output and cache reuse"
				/>
				<MetricCard
					title="API Equivalent (USD)"
					value={formatCost(analytics?.totals.totalCostUsd)}
					change={trends.cost?.change}
					trend={trends.cost?.direction ?? "flat"}
					favorable={trends.cost?.favorable}
					trendPeriod={trends.period}
					icon={DollarSign}
					note={getEstimatedCostNote(analytics?.totals.unpricedRequests ?? 0)}
					warning={(analytics?.totals.unpricedRequests ?? 0) > 0}
				/>
				<MetricCard
					title="Output Speed"
					value={formatTokensPerSecond(analytics?.totals.avgTokensPerSecond)}
					change={trends.outputSpeed?.change}
					trend={trends.outputSpeed?.direction ?? "flat"}
					favorable={trends.outputSpeed?.favorable}
					trendPeriod={trends.period}
					icon={Zap}
					note="Measured streams; historical timing unavailable"
				/>
			</div>

			{analytics && <OverviewCostDetails analytics={analytics} />}

			<ChartsSection
				timeSeriesData={timeSeriesData}
				timeRange={timeRange}
				bucket={analytics?.meta?.bucket ?? ""}
				modelData={modelData}
				accountHealthData={accountHealthData}
				loading={loading}
			/>

			<SystemStatus recentErrors={stats?.recentErrors} />

			{accounts && <RateLimitInfo accounts={accounts} />}

			{/* Configuration Row */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<StrategyCard />
				<DataRetentionCard />
			</div>
		</div>
	);
}
