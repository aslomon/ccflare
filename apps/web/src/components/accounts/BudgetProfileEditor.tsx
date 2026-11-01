import type { BudgetAccountView } from "@ccflare/types";
import { useBudgetProfileModel } from "../../hooks/useBudgetProfileModel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type ProfileModel = ReturnType<typeof useBudgetProfileModel>;

function BudgetModeField({ model }: { model: ProfileModel }) {
	return (
		<Label>
			Budget type
			<select
				className="mt-1 block w-full rounded-md border bg-background p-2"
				value={model.mode}
				onChange={(event) => model.setMode(event.target.value)}
			>
				<option value="auto">Unknown / awaiting configuration</option>
				<option value="claude">Claude subscription</option>
				<option value="codex">Codex subscription</option>
				<option value="zai">Z.ai Coding Plan</option>
				<option value="money">Weekly API spend</option>
				<option value="local">Local inference capacity</option>
			</select>
		</Label>
	);
}

interface ProfileField {
	label: string;
	value: string;
	change: (value: string) => void;
	type?: "number";
	min?: string;
	step?: string;
	placeholder?: string;
}

function moneyFields(model: ProfileModel): ProfileField[] {
	if (model.mode !== "money") return [];
	return [
		{
			label: "Weekly allowance (USD)",
			value: model.allowance,
			change: model.setAllowance,
			type: "number",
			min: "0.01",
			step: "0.01",
		},
		{
			label: "Week start (ISO timestamp)",
			value: model.anchor,
			change: model.setAnchor,
			placeholder: "2026-09-28T00:00:00Z",
		},
	];
}

function BudgetTextFields({ model }: { model: ProfileModel }) {
	const fields: ProfileField[] = [
		{
			label: "Shared budget group",
			value: model.group,
			change: model.setGroup,
		},
		{
			label: "Allowed models (comma separated)",
			value: model.models,
			change: model.setModels,
		},
		...moneyFields(model),
	];
	return fields.map((field) => (
		<Label key={field.label}>
			{field.label}
			<Input
				value={field.value}
				onChange={(event) => field.change(event.target.value)}
				type={field.type ?? "text"}
				min={field.min}
				step={field.step}
				placeholder={field.placeholder}
			/>
		</Label>
	));
}

export function BudgetProfileEditor({
	id,
	budget,
}: {
	id: string;
	budget: BudgetAccountView;
}) {
	const model = useBudgetProfileModel(id, budget.profile);
	return (
		<details className="text-xs">
			<summary className="cursor-pointer text-muted-foreground">
				Budget settings
			</summary>
			<div className="mt-3 grid gap-3 sm:grid-cols-2">
				<BudgetModeField model={model} />
				<BudgetTextFields model={model} />
				<p className="text-muted-foreground sm:col-span-2">
					Accounts sharing one subscription need the same group. API spend
					covers requests through ccflare only.
				</p>
				{model.save.error && (
					<p role="alert" className="text-destructive">
						{model.save.error.message}
					</p>
				)}
				<Button
					size="sm"
					variant="outline"
					disabled={model.save.isPending}
					onClick={() => model.save.mutate()}
				>
					Save budget settings
				</Button>
			</div>
		</details>
	);
}
