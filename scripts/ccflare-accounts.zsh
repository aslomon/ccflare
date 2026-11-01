#!/bin/zsh

set -euo pipefail

base_url="${CCFLARE_BASE_URL:-http://127.0.0.1:8081}"
curl_bin="${CCFLARE_CURL_BIN:-curl}"
open_bin="${CCFLARE_OPEN_BIN:-open}"
prompt_result=""

if [[ -t 1 ]]; then
	accent=$'\e[38;5;208m'
	success=$'\e[32m'
	warning=$'\e[33m'
	muted=$'\e[2m'
	reset=$'\e[0m'
else
	accent="" success="" warning="" muted="" reset=""
fi

die() {
	print -u2 -- "Error: $1"
	exit 1
}

require_command() {
	command -v "$1" >/dev/null || die "Required command is missing: $1"
}

api_request() {
	local method="$1" endpoint="$2" body="${3:-}"
	local -a arguments=(-fsS --max-time 30 -X "$method" "$base_url$endpoint")
	if [[ -n "$body" ]]; then
		arguments+=(-H 'Content-Type: application/json' --data-binary '@-')
		print -rn -- "$body" | "$curl_bin" "${arguments[@]}"
		return
	fi
	"$curl_bin" "${arguments[@]}"
}

validate_base_url() {
	[[ "${CCFLARE_ALLOW_REMOTE:-0}" == "1" ]] && return 0
	case "$base_url" in
		http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) return 0 ;;
		*) die "Refusing non-loopback URL. Set CCFLARE_ALLOW_REMOTE=1 to override." ;;
	esac
}

ensure_service() {
	api_request GET /health >/dev/null ||
		die "ccflare is not reachable at $base_url."
}

get_accounts() {
	api_request GET /api/accounts
}

account_by_name() {
	local accounts="$1" name="$2"
	print -r -- "$accounts" |
		jq -cer --arg name "$name" '.[] | select(.name == $name)' 2>/dev/null
}

account_state() {
	local account="$1"
	if [[ "$(print -r -- "$account" | jq -r '.paused')" == "true" ]]; then
		print -- "paused"
	elif [[ "$(print -r -- "$account" | jq -r '.rateLimitStatus.isLimited')" == "true" ]]; then
		print -- "rate-limited"
	elif [[ "$(print -r -- "$account" | jq -r '.tokenStatus')" != "valid" ]]; then
		print -- "expired"
	else
		print -- "ready"
	fi
}

list_accounts() {
	local accounts account account_state_label
	accounts="$(get_accounts)"
	print -- "${accent}ccflare accounts${reset}  ${muted}$base_url${reset}"
	printf '%-30s %-13s %-14s %10s\n' "NAME" "PROVIDER" "STATE" "REQUESTS"
	print -- "────────────────────────────────────────────────────────────────────────"
	while IFS= read -r account; do
		account_state_label="$(account_state "$account")"
		printf '%-30s %-13s %-14s %10s\n' \
			"$(print -r -- "$account" | jq -r '.name')" \
			"$(print -r -- "$account" | jq -r '.provider')" \
			"$account_state_label" \
			"$(print -r -- "$account" | jq -r '.totalRequests')"
	done < <(print -r -- "$accounts" | jq -c '.[]')
}

prompt_value() {
	local label="$1" secret="${2:-false}"
	prompt_result=""
	if [[ -t 0 ]]; then
		if [[ "$secret" == "true" ]]; then
			IFS= read -rs "prompt_result?$label" </dev/tty
			print -- "" >/dev/tty
		else
			IFS= read -r "prompt_result?$label" </dev/tty
		fi
	else
		IFS= read -r prompt_result
	fi
}

add_oauth_account() {
	local name="$1" provider="$2" response session_id auth_url code body
	body="$(jq -cn --arg name "$name" '{name: $name}')"
	response="$(api_request POST "/api/auth/$provider/init" "$body")"
	session_id="$(print -r -- "$response" | jq -er '.data.sessionId')"
	auth_url="$(print -r -- "$response" | jq -er '.data.authUrl')"
	print -- "Open this ${accent}$provider${reset} authorization URL in your browser:"
	print -r -- "$auth_url"
	if [[ -z "${SSH_CONNECTION:-}" && -z "${SSH_TTY:-}" ]] && command -v "$open_bin" >/dev/null; then
		"$open_bin" "$auth_url" >/dev/null 2>&1 ||
			print -- "Could not open a browser automatically; use the URL above."
	fi
	print -- "Paste the complete authorization code, including #…"
	prompt_value "Authorization Code: " true
	code="$prompt_result"
	[[ -n "$code" ]] || die "No authorization code was provided."
	body="$(print -rn -- "$code" | jq -Rsc --arg sessionId "$session_id" \
		'{sessionId: $sessionId, code: .}')"
	api_request POST "/api/auth/$provider/complete" "$body" |
		jq -e '.success == true' >/dev/null
}

add_api_key_account() {
	local name="$1" provider="$2" api_key body
	prompt_value "API key for $name: " true
	api_key="$prompt_result"
	[[ -n "$api_key" ]] || die "No API key was provided."
	body="$(print -rn -- "$api_key" | jq -Rsc --arg name "$name" --arg provider "$provider" \
		'{name: $name, provider: $provider, auth_method: "api_key", api_key: .}')"
	api_request POST /api/accounts "$body" | jq -e '.success == true' >/dev/null
}

add_account() {
	local name="$1" provider="${2:-claude-code}" accounts
	[[ -n "$name" ]] || die "The account name is missing."
	case "$provider" in
		claude-code|codex|anthropic|openai) ;;
		*) die "Unknown provider: $provider" ;;
	esac
	accounts="$(get_accounts)"
	if account_by_name "$accounts" "$name" >/dev/null; then
		die "Account '$name' already exists. Use replace."
	fi
	case "$provider" in
		claude-code|codex) add_oauth_account "$name" "$provider" ;;
		anthropic|openai) add_api_key_account "$name" "$provider" ;;
	esac
	print -- "${success}Account '$name' was added.${reset}"
}

set_pause_state() {
	local action="$1" name="$2" accounts account id
	accounts="$(get_accounts)"
	account="$(account_by_name "$accounts" "$name")" || die "Account '$name' was not found."
	id="$(print -r -- "$account" | jq -er '.id')"
	api_request POST "/api/accounts/$id/$action" >/dev/null
	print -- "${success}Account '$name': $action.${reset}"
}

rename_account() {
	local old_name="$1" new_name="$2" accounts account id body
	accounts="$(get_accounts)"
	account="$(account_by_name "$accounts" "$old_name")" || die "Account '$old_name' was not found."
	account_by_name "$accounts" "$new_name" >/dev/null && die "Account '$new_name' already exists."
	id="$(print -r -- "$account" | jq -er '.id')"
	body="$(jq -cn --arg name "$new_name" '{name: $name}')"
	api_request PATCH "/api/accounts/$id" "$body" >/dev/null
	print -- "${success}'$old_name' was renamed to '$new_name'.${reset}"
}

replace_account() {
	local name="$1" accounts old_account old_id provider stamp temporary backup new_account new_id body
	accounts="$(get_accounts)"
	old_account="$(account_by_name "$accounts" "$name")" || die "Account '$name' was not found."
	old_id="$(print -r -- "$old_account" | jq -er '.id')"
	provider="$(print -r -- "$old_account" | jq -er '.provider')"
	stamp="${CCFLARE_NOW:-$(date '+%Y%m%d-%H%M%S')}"
	temporary="$name reauth $stamp"
	backup="$name old $stamp"
	add_account "$temporary" "$provider"
	accounts="$(get_accounts)"
	new_account="$(account_by_name "$accounts" "$temporary")" || die "The replacement account was not found."
	[[ "$(account_state "$new_account")" == "ready" ]] || die "The replacement account is not ready."
	new_id="$(print -r -- "$new_account" | jq -er '.id')"
	api_request POST "/api/accounts/$old_id/pause" >/dev/null
	body="$(jq -cn --arg name "$backup" '{name: $name}')"
	api_request PATCH "/api/accounts/$old_id" "$body" >/dev/null
	body="$(jq -cn --arg name "$name" '{name: $name}')"
	if ! api_request PATCH "/api/accounts/$new_id" "$body" >/dev/null; then
		body="$(jq -cn --arg name "$name" '{name: $name}')"
		api_request PATCH "/api/accounts/$old_id" "$body" >/dev/null || true
		die "Replacement failed; the previous name was restored."
	fi
	api_request POST "/api/accounts/$new_id/resume" >/dev/null
	print -- "${success}'$name' was replaced.${reset} Backup: '$backup' (paused)."
}

remove_account() {
	local name="$1" accounts account id
	accounts="$(get_accounts)"
	account="$(account_by_name "$accounts" "$name")" || die "Account '$name' was not found."
	print -- "${warning}Removal deletes the stored credentials for '$name'.${reset}"
	prompt_value "Type the exact account name to confirm: "
	[[ "$prompt_result" == "$name" ]] || die "Removal cancelled."
	id="$(print -r -- "$account" | jq -er '.id')"
	api_request DELETE "/api/accounts/$id" >/dev/null
	print -- "${success}Account '$name' was removed.${reset}"
}

usage() {
	print -- "Usage:"
	print -- "  ccflare-accounts                  Interactive menu"
	print -- "  ccflare-accounts list"
	print -- "  ccflare-accounts add NAME [PROVIDER]"
	print -- "  ccflare-accounts replace NAME"
	print -- "  ccflare-accounts pause NAME"
	print -- "  ccflare-accounts resume NAME"
	print -- "  ccflare-accounts rename OLD NEW"
	print -- "  ccflare-accounts remove NAME"
	print -- "  ccflare-accounts dashboard"
	print -- "Providers: claude-code (default), codex, anthropic, openai"
}

interactive_menu() {
	while true; do
		print -- ""
		list_accounts
		print -- "\n${accent}1${reset} Add  ${accent}2${reset} Replace  ${accent}3${reset} Pause  ${accent}4${reset} Resume  ${accent}5${reset} Rename  ${accent}6${reset} Remove  ${accent}7${reset} Dashboard  ${accent}q${reset} Quit"
		prompt_value "Selection: "
		case "$prompt_result" in
			1) prompt_value "New account name: "; local name="$prompt_result"; prompt_value "Provider [claude-code]: "; add_account "$name" "${prompt_result:-claude-code}" ;;
			2) prompt_value "Account to replace: "; replace_account "$prompt_result" ;;
			3) prompt_value "Account to pause: "; set_pause_state pause "$prompt_result" ;;
			4) prompt_value "Account to resume: "; set_pause_state resume "$prompt_result" ;;
			5) prompt_value "Current name: "; local old="$prompt_result"; prompt_value "New name: "; rename_account "$old" "$prompt_result" ;;
			6) prompt_value "Account to remove: "; remove_account "$prompt_result" ;;
			7) "$open_bin" "$base_url" ;;
			q|Q) return 0 ;;
			*) print -u2 -- "Invalid selection." ;;
		esac
	done
}

main() {
	case "${1:-}" in
		help|-h|--help) usage; return 0 ;;
	esac
	validate_base_url
	require_command "$curl_bin"
	require_command jq
	ensure_service
	case "${1:-menu}" in
		menu) interactive_menu ;;
		list) list_accounts ;;
		add) (( $# >= 2 )) || die "NAME is required."; add_account "$2" "${3:-claude-code}" ;;
		replace) (( $# == 2 )) || die "NAME is required."; replace_account "$2" ;;
		pause|resume) (( $# == 2 )) || die "NAME is required."; set_pause_state "$1" "$2" ;;
		rename) (( $# == 3 )) || die "OLD and NEW are required."; rename_account "$2" "$3" ;;
		remove) (( $# == 2 )) || die "NAME is required."; remove_account "$2" ;;
		dashboard) require_command "$open_bin"; "$open_bin" "$base_url" ;;
		*) usage; die "Unknown command: $1" ;;
	esac
}

main "$@"
