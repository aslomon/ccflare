import type { BudgetProfile } from "@ccflare/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { queryKeys } from "../lib/query-keys";

function isBudgetMode(value: string): value is BudgetProfile["mode"] {
	return (
		value === "auto" ||
		value === "claude" ||
		value === "zai" ||
		value === "money"
	);
}

function useSaveBudgetProfile(id: string, profile: BudgetProfile) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: () => api.setBudgetProfile(id, profile),
		onSuccess: () =>
			client.invalidateQueries({ queryKey: queryKeys.accounts() }),
	});
}

export function useBudgetProfileModel(id: string, initial: BudgetProfile) {
	const [group, setGroup] = useState(initial.groupId ?? "");
	const [mode, setMode] = useState(initial.mode);
	const [models, setModels] = useState(initial.models.join(", "));
	const [allowance, setAllowance] = useState(
		initial.weeklyUsd?.toString() ?? "",
	);
	const [anchor, setAnchor] = useState(
		initial.weekAnchor ? new Date(initial.weekAnchor).toISOString() : "",
	);
	const save = useSaveBudgetProfile(id, {
		mode,
		groupId: group.trim() || null,
		models: models
			.split(",")
			.map((model) => model.trim())
			.filter(Boolean),
		weeklyUsd: allowance ? Number(allowance) : null,
		weekAnchor: anchor ? Date.parse(anchor) : null,
	});
	return {
		group,
		setGroup,
		mode,
		models,
		setModels,
		allowance,
		setAllowance,
		anchor,
		setAnchor,
		save,
		setMode: (value: string) => {
			if (isBudgetMode(value)) setMode(value);
		},
	};
}
