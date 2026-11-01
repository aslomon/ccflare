import type { Config } from "@ccflare/config";
import {
	budgetHistoryQuerySchema,
	budgetPolicySchema,
	budgetProfileSchema,
	readBoundedBody,
} from "@ccflare/core";
import type { DatabaseOperations } from "@ccflare/database";
import type { BudgetManagement } from "@ccflare/types";

async function input(req: Request): Promise<unknown> {
	const buffer = await readBoundedBody(req, 16_384);
	if (!buffer) throw new Error("Missing budget payload");
	return JSON.parse(new TextDecoder().decode(buffer));
}
const invalid = () =>
	Response.json(
		{
			error: {
				type: "invalid_budget_configuration",
				message: "Invalid budget policy or profile",
			},
		},
		{ status: 400 },
	);
function policyHandler(config: Config, budgets: BudgetManagement) {
	return async (req: Request): Promise<Response> => {
		try {
			const policy = budgetPolicySchema.parse(await input(req));
			config.setBudgetPolicy(policy);
			budgets.configure(config.getBudgetPolicy());
			await budgets.refresh();
			return Response.json({ success: true, policy: budgets.policy });
		} catch {
			return invalid();
		}
	};
}

function profileHandler(dbOps: DatabaseOperations, budgets: BudgetManagement) {
	return async (req: Request, id: string): Promise<Response> => {
		const account = dbOps.getAccount(id);
		if (!account)
			return Response.json(
				{ error: { type: "not_found", message: "Account not found" } },
				{ status: 404 },
			);
		try {
			budgets.setProfile(account, budgetProfileSchema.parse(await input(req)));
			await budgets.refresh();
			return Response.json({ success: true, budget: budgets.view(account) });
		} catch {
			return invalid();
		}
	};
}

function historyHandler(dbOps: DatabaseOperations, budgets: BudgetManagement) {
	return (req: Request): Response => {
		const query = budgetHistoryQuerySchema.safeParse(
			Object.fromEntries(new URL(req.url).searchParams),
		);
		if (!query.success) return invalid();
		if (query.data.accountId && !dbOps.getAccount(query.data.accountId))
			return Response.json(
				{ error: { type: "not_found", message: "Account not found" } },
				{ status: 404 },
			);
		return Response.json(budgets.history(query.data));
	};
}

export function createBudgetHandlers(
	dbOps: DatabaseOperations,
	config: Config,
	budgets: BudgetManagement,
) {
	return {
		history: historyHandler(dbOps, budgets),
		get: () =>
			Response.json({
				controllerVersion: 2,
				policy: budgets.policy,
				accounts: dbOps.getAllAccounts().map((account) => ({
					id: account.id,
					name: account.name,
					...budgets.view(account),
				})),
			}),
		policy: policyHandler(config, budgets),
		profile: profileHandler(dbOps, budgets),
		async refresh(): Promise<Response> {
			await budgets.refresh();
			return Response.json({ success: true });
		},
	};
}
