import type { Config } from "@ccflare/config";
import {
	NETWORK,
	RETENTION_DAYS,
	TIME_CONSTANTS,
	ValidationError,
	validateNumber,
} from "@ccflare/core";
import { BadRequest, errorResponse, jsonResponse } from "@ccflare/http";
import {
	type ConfigResponse,
	isLbStrategy,
	LB_STRATEGIES,
	type MutationResult,
	type RetentionGetResponse,
	type StrategyResponse,
} from "@ccflare/types";
import { parseJsonObject } from "../utils/json";

/**
 * Create config handlers
 */
export function createConfigHandlers(config: Config) {
	return {
		/**
		 * Get all configuration settings
		 */
		getConfig: (): Response => {
			const runtime = config.getRuntime();
			const response: ConfigResponse = {
				lbStrategy: config.getStrategy(),
				port: runtime.port ?? NETWORK.DEFAULT_PORT,
				sessionDurationMs:
					runtime.sessionDurationMs ?? TIME_CONSTANTS.SESSION_DURATION_FALLBACK,
				sessionRotation: runtime.sessionRotation,
			};
			return jsonResponse(response);
		},

		/**
		 * Get current strategy
		 */
		getStrategy: (): Response => {
			const strategy = config.getStrategy();
			const response: StrategyResponse = { strategy };
			return jsonResponse(response);
		},

		/**
		 * Update strategy
		 */
		setStrategy: async (req: Request): Promise<Response> => {
			try {
				const body = await parseJsonObject(req);
				const strategy = body.strategy;
				if (typeof strategy !== "string" || !isLbStrategy(strategy)) {
					return errorResponse(BadRequest("Strategy is required"));
				}

				config.setStrategy(strategy);

				const result: MutationResult<StrategyResponse> = {
					success: true,
					message: `Strategy updated to '${strategy}'`,
					data: { strategy },
				};
				return jsonResponse(result);
			} catch (error) {
				if (error instanceof ValidationError) {
					return errorResponse(BadRequest(error.message));
				}
				throw error;
			}
		},

		/**
		 * Get available strategies
		 */
		getStrategies: (): Response => {
			return jsonResponse(LB_STRATEGIES);
		},

		/**
		 * Get current data retention in days
		 */
		getRetention: (): Response => {
			const response: RetentionGetResponse = {
				payloadDays: config.getDataRetentionDays(),
				requestDays: config.getRequestRetentionDays(),
			};
			return jsonResponse(response);
		},

		/**
		 * Set data retention in days
		 */
		setRetention: async (req: Request): Promise<Response> => {
			try {
				const body = await parseJsonObject(req);
				let updated = false;
				if (body.payloadDays !== undefined) {
					const payloadDays = validateNumber(body.payloadDays, "payloadDays", {
						min: 1,
						max: 365,
						integer: true,
					});
					if (typeof payloadDays !== "number") {
						return errorResponse(BadRequest("Invalid 'payloadDays'"));
					}
					config.setDataRetentionDays(payloadDays);
					updated = true;
				}
				if (body.requestDays !== undefined) {
					const requestDays = validateNumber(body.requestDays, "requestDays", {
						min: RETENTION_DAYS.REQUEST_MIN,
						max: RETENTION_DAYS.REQUEST_MAX,
						integer: true,
					});
					if (typeof requestDays !== "number") {
						return errorResponse(BadRequest("Invalid 'requestDays'"));
					}
					config.setRequestRetentionDays(requestDays);
					updated = true;
				}
				if (!updated) {
					return errorResponse(BadRequest("No retention fields provided"));
				}
				const result: MutationResult = {
					success: true,
					message: "Retention settings updated",
				};
				return jsonResponse(result);
			} catch (error) {
				if (error instanceof ValidationError) {
					return errorResponse(BadRequest(error.message));
				}
				throw error;
			}
		},
	};
}
