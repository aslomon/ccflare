#!/bin/zsh

set -euo pipefail

base_url="http://127.0.0.1:8081"
account_name="zai-glm"
endpoint="https://api.z.ai/api/anthropic"

wait_before_close() {
	local exit_code=$?
	trap - EXIT
	if (( exit_code != 0 )); then
		print -u2 -- ""
		print -u2 -- "Setup failed. No placeholder credential was stored."
	fi
	print -- ""
	print -- "Press Enter to close this Terminal window."
	IFS= read -r </dev/tty || true
	exit "$exit_code"
}

trap wait_before_close EXIT

for command_name in curl jq; do
	command -v "$command_name" >/dev/null || {
		print -u2 -- "Required command is missing: $command_name"
		exit 1
	}
done

curl -fsS --max-time 5 "$base_url/health" >/dev/null

if curl -fsS --max-time 5 "$base_url/api/accounts" |
	jq -e --arg name "$account_name" 'any(.[]; .name == $name)' >/dev/null; then
	print -u2 -- "Account '$account_name' already exists."
	print -u2 -- "Remove or replace it through ccflare-accounts before running this setup again."
	exit 1
fi

print -- "Add z.ai GLM as an Anthropic-compatible ccflare account"
print -- "Endpoint: $endpoint"
print -- ""
IFS= read -rs "zai_key?Z.AI API key: " </dev/tty
print -- ""

[[ -n "$zai_key" ]] || {
	print -u2 -- "No API key was provided."
	exit 1
}

payload="$(
	print -rn -- "$zai_key" |
		jq -Rsc \
			--arg name "$account_name" \
			--arg endpoint "$endpoint" \
			'{
				name: $name,
				provider: "anthropic",
				auth_method: "api_key",
				api_key: .,
				base_url: $endpoint
			}'
)"

print -rn -- "$payload" |
	curl -fsS --max-time 30 \
		-X POST "$base_url/api/accounts" \
		-H "content-type: application/json" \
		--data-binary @- |
	jq -e '.success == true' >/dev/null

unset zai_key payload

print -- ""
print -- "Account created successfully:"
curl -fsS --max-time 5 "$base_url/api/accounts" |
	jq --arg name "$account_name" \
		'.[] | select(.name == $name) |
		{name, provider, auth_method, base_url, paused, tokenStatus, rateLimitStatus}'
