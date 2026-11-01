import { budgetProfileSchema } from "@ccflare/core";
import type { Account, BudgetProfile } from "@ccflare/types";
import type { BudgetControl } from "./control";
import {
	accountOrigin,
	credentialGroup,
	isCodexEndpoint,
	isZaiCodingEndpoint,
} from "./profiles";

export function saveBudgetProfile(
	control: BudgetControl,
	account: Account,
	value: BudgetProfile,
): void {
	const profile = budgetProfileSchema.parse(value);
	if ((profile.mode === "local") !== (account.provider === "lmstudio"))
		throw new Error("Local capacity mode requires an LM Studio account");
	if (
		profile.mode === "claude" &&
		(account.provider !== "claude-code" ||
			accountOrigin(account) !== "https://api.anthropic.com")
	)
		throw new Error("Incompatible Claude profile");
	if (profile.mode === "codex" && !isCodexEndpoint(account))
		throw new Error("Incompatible Codex profile");
	if (profile.mode === "zai" && !isZaiCodingEndpoint(account))
		throw new Error("Incompatible Z.ai profile");
	if (
		profile.mode === "grok" &&
		(account.provider !== "grok-build" ||
			accountOrigin(account) !== "https://cli-chat-proxy.grok.com")
	)
		throw new Error("Incompatible Grok profile");
	if (profile.mode === "money" && profile.models.length === 0)
		throw new Error("Money profiles require explicit models");
	for (const peer of control.dbOps.getAllAccounts()) {
		if (peer.id === account.id) continue;
		const other = control.repo.profile(peer.id);
		if (
			credentialGroup(peer) === credentialGroup(account) &&
			profile.groupId !== control.profile(peer).groupId
		)
			throw new Error("Identical credentials require a shared budget group");
		if (
			profile.groupId &&
			other?.groupId === profile.groupId &&
			(profile.mode !== other.mode ||
				profile.weeklyUsd !== other.weeklyUsd ||
				profile.weekAnchor !== other.weekAnchor)
		)
			throw new Error("Incompatible shared budget group");
	}
	control.repo.saveProfile(account.id, profile);
}
