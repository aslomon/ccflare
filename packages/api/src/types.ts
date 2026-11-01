import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import type {
	AccountProvider,
	AuthMethod,
	BudgetAccountView,
	BudgetManagement,
	RuntimeHealth,
} from "@ccflare/types";

export interface AccountResponse {
	budget?: BudgetAccountView;
	manualPaused?: boolean;
	id: string;
	name: string;
	provider: AccountProvider;
	auth_method: AuthMethod;
	base_url: string | null;
	requestCount: number;
	totalRequests: number;
	lastUsed: string | null;
	created: string;
	weight: number;
	paused: boolean;
	tokenStatus: "valid" | "expired";
	tokenExpiresAt: string | null;
	rateLimitStatus: {
		code: string;
		isLimited: boolean;
		until: string | null;
	};
	rateLimitReset: string | null;
	rateLimitRemaining: number | null;
	sessionInfo: {
		active: boolean;
		startedAt: string | null;
		requestCount: number;
	};
}

export interface APIContext {
	budgets?: BudgetManagement;
	config: Config;
	dbOps: DatabaseOperations;
	getProviders: () => string[];
	getRuntimeHealth?: () => RuntimeHealth;
}
