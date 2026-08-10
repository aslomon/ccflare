import type { TimeRange } from "@ccflare/types";
import { TIME_RANGES } from "@ccflare/ui";
import {
	useChartColorSequence,
	useChartColors,
} from "../../hooks/useChartColors";
import {
	BaseAreaChart,
	BaseBarChart,
	BaseLineChart,
	BasePieChart,
} from "../charts";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import type { OverviewTimeSeriesPoint } from "./overview-data";

function describeBucket(bucket: string): string {
	switch (bucket) {
		case "1m":
			return "minute";
		case "5m":
			return "5 minutes";
		case "1h":
			return "hour";
		case "1d":
			return "day";
		default:
			return "period";
	}
}

interface ChartsSectionProps {
	timeSeriesData: OverviewTimeSeriesPoint[];
	timeRange: TimeRange;
	bucket: string;
	modelData: Array<{ name: string; value: number }>;
	accountHealthData: Array<{
		name: string;
		requests: number;
		successRate: number;
	}>;
	loading: boolean;
}

export function ChartsSection({
	timeSeriesData,
	timeRange,
	bucket,
	modelData,
	accountHealthData,
	loading,
}: ChartsSectionProps) {
	const colors = useChartColors();
	const chartColors = useChartColorSequence();
	const rangeLabel = TIME_RANGES[timeRange].toLowerCase();

	return (
		<>
			{/* Charts Row 1 */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{/* Request Volume Chart */}
				<Card>
					<CardHeader>
						<CardTitle>Request Volume</CardTitle>
						<CardDescription>
							Requests per {describeBucket(bucket)} over {rangeLabel}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<BaseAreaChart
							data={timeSeriesData}
							dataKey="requests"
							loading={loading}
							height="medium"
						/>
					</CardContent>
				</Card>

				{/* Success Rate Chart */}
				<Card>
					<CardHeader>
						<CardTitle>Success Rate Trend</CardTitle>
						<CardDescription>Success percentage over time</CardDescription>
					</CardHeader>
					<CardContent>
						<BaseLineChart
							data={timeSeriesData}
							lines={{ dataKey: "successRate", stroke: colors.success }}
							loading={loading}
							height="medium"
							yAxisDomain={[80, 100]}
						/>
					</CardContent>
				</Card>
			</div>

			{/* Charts Row 2 */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Model Distribution */}
				<Card>
					<CardHeader>
						<CardTitle>Model Usage</CardTitle>
						<CardDescription>
							Distribution of API calls by model
						</CardDescription>
					</CardHeader>
					<CardContent>
						<BasePieChart
							data={modelData}
							loading={loading}
							height="small"
							innerRadius={60}
							outerRadius={80}
							paddingAngle={5}
							tooltipStyle="success"
						/>
						<div className="mt-4 space-y-2">
							{modelData.map((model, index) => (
								<div
									key={model.name}
									className="flex items-center justify-between text-sm"
								>
									<div className="flex items-center gap-2">
										<div
											className="h-3 w-3 rounded-full"
											style={{
												backgroundColor:
													chartColors[index % chartColors.length],
											}}
										/>
										<span className="text-muted-foreground">{model.name}</span>
									</div>
									<span className="font-medium">{model.value}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>

				{/* Account Health */}
				<Card className="lg:col-span-2">
					<CardHeader>
						<CardTitle>Account Performance</CardTitle>
						<CardDescription>
							Request distribution and success rates by account
						</CardDescription>
					</CardHeader>
					<CardContent>
						<BaseBarChart
							data={accountHealthData}
							bars={[
								{ dataKey: "requests", yAxisId: "left", name: "Requests" },
								{
									dataKey: "successRate",
									yAxisId: "right",
									fill: colors.success,
									name: "Success %",
								},
							]}
							xAxisKey="name"
							loading={loading}
							height="small"
							secondaryYAxis={true}
							showLegend={true}
						/>
					</CardContent>
				</Card>
			</div>
		</>
	);
}
