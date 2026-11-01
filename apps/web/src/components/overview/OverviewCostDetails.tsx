import { formatCost } from "@ccflare/core";
import type { AnalyticsResponse, TokenBreakdown } from "@ccflare/types";
import { formatNumber, formatTokens } from "@ccflare/ui";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

function TokenCategories({ tokens }: { tokens: TokenBreakdown }) {
	const categories = [
		{ name: "Uncached input", tokens: tokens.inputTokens },
		{ name: "Cache reads", tokens: tokens.cacheReadInputTokens },
		{ name: "Cache writes", tokens: tokens.cacheCreationInputTokens },
		{ name: "Output", tokens: tokens.outputTokens },
	];
	return (
		<dl className="grid grid-cols-2 lg:grid-cols-4 gap-4">
			{categories.map((category) => (
				<div key={category.name}>
					<dt className="text-xs text-muted-foreground">{category.name}</dt>
					<dd className="text-sm font-medium">
						{formatTokens(category.tokens)} tokens
					</dd>
				</div>
			))}
		</dl>
	);
}

function ModelCosts({ models }: { models: AnalyticsResponse["costByModel"] }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<caption className="text-left text-xs text-muted-foreground py-2">
					Top models by API equivalent; request counts include positive
					estimates.
				</caption>
				<thead>
					<tr className="border-b text-muted-foreground">
						<th scope="col" className="text-left py-2 font-medium">
							Model
						</th>
						<th scope="col" className="text-right py-2 font-medium">
							Requests
						</th>
						<th scope="col" className="text-right py-2 font-medium">
							API equivalent (USD)
						</th>
					</tr>
				</thead>
				<tbody>
					{models.map((model) => (
						<tr key={model.model} className="border-b last:border-0">
							<td className="py-2 pr-4">{model.model}</td>
							<td className="py-2 text-right">
								{formatNumber(model.requests)}
							</td>
							<td className="py-2 text-right">{formatCost(model.costUsd)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function OverviewCostDetails({
	analytics,
}: {
	analytics: AnalyticsResponse;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>What the API estimate includes</CardTitle>
				<CardDescription>
					Current standard API token prices from OpenRouter. Cache reuse counts
					on every request; these are token totals, not unique tokens or just
					generated output. Subscription fees and unrecorded surcharges are
					excluded.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<TokenCategories tokens={analytics.tokenBreakdown} />
				{(analytics.totals.requestsWithoutUsage ?? 0) > 0 && (
					<p className="text-xs text-muted-foreground">
						No model or token usage recorded for{" "}
						{formatNumber(analytics.totals.requestsWithoutUsage ?? 0)} proxy
						requests. They do not contribute a confirmed API estimate.
					</p>
				)}
				{analytics.costByModel.length > 0 ? (
					<ModelCosts models={analytics.costByModel} />
				) : (
					<p className="text-sm text-muted-foreground">
						No positive API estimate in this range.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
