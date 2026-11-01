import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	budgetPolicySchema,
	DEFAULT_STRATEGY,
	isValidStrategy,
	RETENTION_DAYS,
	SESSION_ROTATION_DEFAULTS,
	sessionRotationSchema,
} from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import {
	type BudgetPolicy,
	isFiniteNumber,
	isLbStrategy,
	isRecord,
	type SessionRotationWindow,
	type StrategyName,
} from "@ccflare/types";
import { resolveConfigPath } from "./paths";
import { buildRuntimeConfig } from "./runtime-config";

const log = new Logger("Config");

export interface RuntimeConfig {
	budgetPolicy?: BudgetPolicy;
	clientId: string;
	retry: { attempts: number; delayMs: number; backoff: number };
	sessionDurationMs: number;
	sessionRotation?: SessionRotationWindow;
	port: number;
}

export interface ConfigData {
	lb_strategy?: StrategyName;
	client_id?: string;
	retry_attempts?: number;
	retry_delay_ms?: number;
	retry_backoff?: number;
	session_duration_ms?: number;
	session_rotation_min_ms?: number;
	session_rotation_max_ms?: number;
	port?: number;
	data_retention_days?: number;
	request_retention_days?: number;
	[key: string]: string | number | boolean | undefined;
}

function sanitizeConfigData(value: unknown): ConfigData {
	if (!isRecord(value)) {
		return {};
	}

	const sanitized: ConfigData = {};

	for (const [key, entry] of Object.entries(value)) {
		if (
			typeof entry === "string" ||
			typeof entry === "boolean" ||
			isFiniteNumber(entry)
		) {
			sanitized[key] = entry;
		}
	}

	if (!isLbStrategy(String(sanitized.lb_strategy ?? ""))) {
		delete sanitized.lb_strategy;
	}

	const numericKeys = [
		"retry_attempts",
		"retry_delay_ms",
		"retry_backoff",
		"session_duration_ms",
		"port",
		"data_retention_days",
		"request_retention_days",
	] as const;

	for (const key of numericKeys) {
		const entry = sanitized[key];
		if (entry !== undefined && !isFiniteNumber(entry)) {
			delete sanitized[key];
		}
	}

	if (
		sanitized.client_id !== undefined &&
		typeof sanitized.client_id !== "string"
	) {
		delete sanitized.client_id;
	}

	return sanitized;
}

export class Config extends EventEmitter {
	private configPath: string;
	private data: ConfigData = {};

	constructor(configPath?: string) {
		super();
		this.configPath = configPath ?? resolveConfigPath();
		this.loadConfig();
	}

	private loadConfig(): void {
		if (existsSync(this.configPath)) {
			try {
				const content = readFileSync(this.configPath, "utf8");
				this.data = sanitizeConfigData(JSON.parse(content));
				if ("default_agent_model" in this.data) {
					delete this.data.default_agent_model;
					this.saveConfig();
				}
			} catch (error) {
				log.error(`Failed to parse config file: ${error}`);
				this.data = {};
			}
		} else {
			// Create config directory if it doesn't exist
			const dir = dirname(this.configPath);
			mkdirSync(dir, { recursive: true });

			// Initialize with default config
			this.data = {
				lb_strategy: DEFAULT_STRATEGY,
			};
			this.saveConfig();
		}
	}

	private saveConfig(): void {
		try {
			const content = JSON.stringify(this.data, null, 2);
			writeFileSync(this.configPath, content, "utf8");
		} catch (error) {
			log.error(`Failed to save config file: ${error}`);
		}
	}

	get(
		key: string,
		defaultValue?: string | number | boolean,
	): string | number | boolean | undefined {
		if (key in this.data) {
			return this.data[key];
		}

		if (defaultValue !== undefined) {
			this.set(key, defaultValue);
			return defaultValue;
		}

		return undefined;
	}

	set(key: string, value: string | number | boolean): void {
		const oldValue = this.data[key];
		this.data[key] = value;
		this.saveConfig();

		// Emit change event
		this.emit("change", { key, oldValue, newValue: value });
	}

	getStrategy(): StrategyName {
		// First check environment variable
		const envStrategy = process.env.LB_STRATEGY;
		if (envStrategy && isValidStrategy(envStrategy)) {
			return envStrategy;
		}

		// Then check config file
		const configStrategy = this.data.lb_strategy;
		if (configStrategy && isValidStrategy(configStrategy)) {
			return configStrategy;
		}

		return DEFAULT_STRATEGY;
	}

	setStrategy(strategy: StrategyName): void {
		if (!isValidStrategy(strategy)) {
			throw new Error(`Invalid strategy: ${strategy}`);
		}
		this.set("lb_strategy", strategy);
	}

	private clamp(n: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, n));
	}

	getDataRetentionDays(): number {
		const fromEnv = process.env.DATA_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 365);
		}
		const fromFile = this.data.data_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 365);
		return 7;
	}

	setDataRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 365);
		this.set("data_retention_days", clamped);
	}

	getRequestRetentionDays(): number {
		const fromEnv = process.env.REQUEST_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) {
				return this.clamp(
					n,
					RETENTION_DAYS.REQUEST_MIN,
					RETENTION_DAYS.REQUEST_MAX,
				);
			}
		}
		const fromFile = this.data.request_retention_days;
		if (typeof fromFile === "number") {
			return this.clamp(
				fromFile,
				RETENTION_DAYS.REQUEST_MIN,
				RETENTION_DAYS.REQUEST_MAX,
			);
		}
		return 365; // default metadata retention
	}

	setRequestRetentionDays(days: number): void {
		const clamped = this.clamp(
			days,
			RETENTION_DAYS.REQUEST_MIN,
			RETENTION_DAYS.REQUEST_MAX,
		);
		this.set("request_retention_days", clamped);
	}

	getAllSettings(): Record<string, string | number | boolean | undefined> {
		// Include current strategy (which might come from env)
		return {
			...this.data,
			lb_strategy: this.getStrategy(),
			data_retention_days: this.getDataRetentionDays(),
			request_retention_days: this.getRequestRetentionDays(),
		};
	}

	getSessionRotation(): SessionRotationWindow | undefined {
		const minMs =
			process.env.CCFLARE_SESSION_ROTATION_MIN_MS === undefined
				? this.data.session_rotation_min_ms
				: Number(process.env.CCFLARE_SESSION_ROTATION_MIN_MS);
		const maxMs =
			process.env.CCFLARE_SESSION_ROTATION_MAX_MS === undefined
				? this.data.session_rotation_max_ms
				: Number(process.env.CCFLARE_SESSION_ROTATION_MAX_MS);
		if (minMs === undefined && maxMs === undefined) return undefined;
		return sessionRotationSchema.parse({
			minMs: minMs ?? SESSION_ROTATION_DEFAULTS.minMs,
			maxMs: maxMs ?? SESSION_ROTATION_DEFAULTS.maxMs,
		});
	}

	getRuntime(): RuntimeConfig {
		return {
			...buildRuntimeConfig(this.data, this.getSessionRotation()),
			budgetPolicy: this.getBudgetPolicy(),
		};
	}
	getBudgetPolicy(): BudgetPolicy {
		const value = this.data.budget_policy;
		const policy = budgetPolicySchema.parse(
			typeof value === "string" ? JSON.parse(value) : {},
		);
		const enabled = process.env.CCFLARE_BUDGET_ENABLED;
		if (enabled !== undefined && enabled !== "0" && enabled !== "1")
			throw new Error("CCFLARE_BUDGET_ENABLED must be 0 or 1");
		return budgetPolicySchema.parse({
			...policy,
			enabled: enabled === undefined ? policy.enabled : enabled === "1",
			cutoffPercent:
				process.env.CCFLARE_BUDGET_CUTOFF_PERCENT === undefined
					? policy.cutoffPercent
					: Number(process.env.CCFLARE_BUDGET_CUTOFF_PERCENT),
		});
	}
	setBudgetPolicy(value: BudgetPolicy): void {
		this.set("budget_policy", JSON.stringify(budgetPolicySchema.parse(value)));
	}
}

export { resolveConfigPath } from "./paths";
export { getPlatformConfigDir } from "./paths-common";
