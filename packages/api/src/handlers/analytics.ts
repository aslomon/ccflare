import { buildAnalyticsQuery } from "@ccflare/database";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import {
	type AccountProvider,
	type AnalyticsMode,
	type AnalyticsResponse,
	type AnalyticsStatusFilter,
	isAccountProvider,
	isAnalyticsMode,
	isAnalyticsStatusFilter,
	isTimeRange,
	type TimeRange,
} from "@ccflare/types";
import { fillMissingTimeBuckets } from "../analytics-series";
import type { APIContext } from "../types";

const log = new Logger("AnalyticsHandler");

function parseCsvParam(params: URLSearchParams, key: string): string[] {
	return (
		params
			.get(key)
			?.split(",")
			.map((value) => value.trim())
			.filter(Boolean) ?? []
	);
}

function parseRange(params: URLSearchParams): TimeRange | Response {
	const range = params.get("range") ?? "24h";
	return isTimeRange(range)
		? range
		: errorResponse(BadRequest(`Unsupported analytics range '${range}'`));
}

function parseMode(params: URLSearchParams): AnalyticsMode | Response {
	const mode = params.get("mode") ?? "normal";
	return isAnalyticsMode(mode)
		? mode
		: errorResponse(BadRequest(`Unsupported analytics mode '${mode}'`));
}

function parseStatusFilter(
	params: URLSearchParams,
): AnalyticsStatusFilter | Response {
	const status = params.get("status") ?? "all";
	return isAnalyticsStatusFilter(status)
		? status
		: errorResponse(BadRequest(`Unsupported analytics status '${status}'`));
}

function parseProvidersFilter(
	params: URLSearchParams,
): AccountProvider[] | Response {
	const providers = parseCsvParam(params, "providers");
	const validatedProviders: AccountProvider[] = [];

	for (const provider of providers) {
		if (!isAccountProvider(provider)) {
			return errorResponse(BadRequest(`Unknown provider '${provider}'`));
		}
		validatedProviders.push(provider);
	}

	return validatedProviders;
}

export function createAnalyticsHandler(context: APIContext) {
	return async (params: URLSearchParams): Promise<Response> => {
		const range = parseRange(params);
		if (range instanceof Response) {
			return range;
		}
		const mode = parseMode(params);
		if (mode instanceof Response) {
			return mode;
		}
		const isCumulative = mode === "cumulative";

		// Extract filters
		const accountsFilter = parseCsvParam(params, "accounts");
		const modelsFilter = parseCsvParam(params, "models");
		const providersFilter = parseProvidersFilter(params);
		if (providersFilter instanceof Response) {
			return providersFilter;
		}
		const statusFilter = parseStatusFilter(params);
		if (statusFilter instanceof Response) {
			return statusFilter;
		}

		try {
			const includeModelBreakdown = params.get("modelBreakdown") === "true";
			const query = buildAnalyticsQuery({
				range,
				accounts: accountsFilter,
				models: modelsFilter,
				providers: providersFilter,
				status: statusFilter,
				includeModelBreakdown,
			});
			const analytics = context.dbOps.getAnalytics(query.options);

			let transformedTimeSeries = includeModelBreakdown
				? analytics.timeSeries
				: fillMissingTimeBuckets(
						analytics.timeSeries,
						query.options.startMs,
						query.endMs,
						query.options.bucketMs,
					);

			// Apply cumulative transformation if requested
			if (isCumulative && !includeModelBreakdown) {
				let runningRequests = 0;
				let runningTokens = 0;
				let runningCostUsd = 0;

				transformedTimeSeries = transformedTimeSeries.map((point) => {
					runningRequests += point.requests;
					runningTokens += point.tokens;
					runningCostUsd += point.costUsd;

					return {
						...point,
						requests: runningRequests,
						tokens: runningTokens,
						costUsd: runningCostUsd,
						// Keep rates as-is (not cumulative)
					};
				});
			} else if (isCumulative && includeModelBreakdown) {
				// For per-model cumulative, track running totals per model
				const runningTotals: Record<
					string,
					{ requests: number; tokens: number; costUsd: number }
				> = {};

				transformedTimeSeries = transformedTimeSeries.map((point) => {
					if (point.model) {
						if (!runningTotals[point.model]) {
							runningTotals[point.model] = {
								requests: 0,
								tokens: 0,
								costUsd: 0,
							};
						}
						runningTotals[point.model].requests += point.requests;
						runningTotals[point.model].tokens += point.tokens;
						runningTotals[point.model].costUsd += point.costUsd;

						return {
							...point,
							requests: runningTotals[point.model].requests,
							tokens: runningTotals[point.model].tokens,
							costUsd: runningTotals[point.model].costUsd,
						};
					}
					return point;
				});
			}

			const response: AnalyticsResponse = {
				...analytics,
				meta: {
					range: query.meta.range,
					bucket: query.meta.bucket,
					cumulative: isCumulative,
				},
				timeSeries: transformedTimeSeries,
			};

			return jsonResponse(response);
		} catch (error) {
			log.error("Analytics error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch analytics data"),
			);
		}
	};
}
