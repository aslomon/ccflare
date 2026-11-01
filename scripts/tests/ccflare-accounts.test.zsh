#!/bin/zsh

set -euo pipefail

repository_root="${0:A:h:h:h}"
subject="$repository_root/scripts/ccflare-accounts.zsh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/ccflare-accounts-test.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT

export FAKE_ACCOUNTS_FILE="$fixture_root/accounts.json"
export FAKE_PENDING_FILE="$fixture_root/pending.txt"
export FAKE_OPEN_LOG="$fixture_root/open.log"
export FAKE_REQUEST_LOG="$fixture_root/requests.log"
export CCFLARE_BASE_URL="http://ccflare.test"
export CCFLARE_ALLOW_REMOTE=1
export CCFLARE_NOW="20260914-120000"
export CCFLARE_CURL_BIN="$fixture_root/curl"
export CCFLARE_OPEN_BIN="$fixture_root/open"
unset SSH_CONNECTION SSH_TTY

fail() {
	print -u2 -- "FAIL: $1"
	exit 1
}

assert_contains() {
	local value="$1" expected="$2"
	[[ "$value" == *"$expected"* ]] || fail "Expected output to contain: $expected"
}

assert_jq() {
	local expression="$1"
	jq -e "$expression" "$FAKE_ACCOUNTS_FILE" >/dev/null || fail "jq assertion failed: $expression"
}

reset_accounts() {
	print -r -- '[
	  {
	    "id": "primary-id",
	    "name": "Primary",
	    "provider": "claude-code",
	    "paused": false,
	    "tokenStatus": "valid",
	    "rateLimitStatus": {"code": "allowed", "isLimited": false, "until": null},
	    "lastUsed": null,
	    "totalRequests": 12
	  },
	  {
	    "id": "paused-id",
	    "name": "Paused old",
	    "provider": "claude-code",
	    "paused": true,
	    "tokenStatus": "expired",
	    "rateLimitStatus": {"code": "paused", "isLimited": false, "until": null},
	    "lastUsed": null,
	    "totalRequests": 0
	  }
	]' > "$FAKE_ACCOUNTS_FILE"
	: > "$FAKE_PENDING_FILE"
	: > "$FAKE_OPEN_LOG"
	: > "$FAKE_REQUEST_LOG"
}

create_fake_open() {
	cat > "$CCFLARE_OPEN_BIN" <<'FAKE_OPEN'
#!/bin/zsh
print -r -- "$1" >> "$FAKE_OPEN_LOG"
FAKE_OPEN
	chmod 700 "$CCFLARE_OPEN_BIN"
}

create_fake_curl() {
	cat > "$CCFLARE_CURL_BIN" <<'FAKE_CURL'
#!/bin/zsh
set -euo pipefail
method="GET"
data=""
url=""
while (( $# > 0 )); do
	case "$1" in
		-X) method="$2"; shift 2 ;;
		--data|--data-binary) data="$2"; shift 2 ;;
		-H|--max-time|-w|-o) shift 2 ;;
		-f|-s|-S|-fsS|-sS) shift ;;
		*) url="$1"; shift ;;
	esac
done
request_path="${url#$CCFLARE_BASE_URL}"
[[ "$data" == "@-" ]] && data="$(cat)"
print -r -- "$method $request_path" >> "$FAKE_REQUEST_LOG"
case "$method $request_path" in
	"GET /health") print -r -- "{\"status\":\"ok\"}" ;;
	"GET /api/accounts") cat "$FAKE_ACCOUNTS_FILE" ;;
	"POST /api/auth/claude-code/init"|"POST /api/auth/codex/init")
		name="$(print -r -- "$data" | jq -er .name)"
		print -r -- "$name" > "$FAKE_PENDING_FILE"
		print -r -- "{\"success\":true,\"data\":{\"sessionId\":\"session-id\",\"authUrl\":\"https://login.test/oauth\"}}"
		;;
	"POST /api/auth/claude-code/complete"|"POST /api/auth/codex/complete")
		name="$(cat "$FAKE_PENDING_FILE")"
		provider="${request_path#/api/auth/}"
		provider="${provider%/complete}"
		temporary="$(mktemp)"
		jq --arg name "$name" --arg provider "$provider" \
			'. + [{id:"new-id",name:$name,provider:$provider,paused:false,tokenStatus:"valid",rateLimitStatus:{code:"allowed",isLimited:false,until:null},lastUsed:null,totalRequests:0}]' \
			"$FAKE_ACCOUNTS_FILE" > "$temporary"
		mv "$temporary" "$FAKE_ACCOUNTS_FILE"
		print -r -- "{\"success\":true}"
		;;
	"POST /api/accounts")
		name="$(print -r -- "$data" | jq -er .name)"
		provider="$(print -r -- "$data" | jq -er .provider)"
		temporary="$(mktemp)"
		jq --arg name "$name" --arg provider "$provider" \
			'. + [{id:"api-key-id",name:$name,provider:$provider,paused:false,tokenStatus:"valid",rateLimitStatus:{code:"ok",isLimited:false,until:null},lastUsed:null,totalRequests:0}]' \
			"$FAKE_ACCOUNTS_FILE" > "$temporary"
		mv "$temporary" "$FAKE_ACCOUNTS_FILE"
		print -r -- "{\"success\":true}"
		;;
	POST\ /api/accounts/*/pause|POST\ /api/accounts/*/resume)
		id="${request_path#/api/accounts/}"; id="${id%/*}"
		paused=false; [[ "$request_path" == */pause ]] && paused=true
		temporary="$(mktemp)"
		jq --arg id "$id" --argjson paused "$paused" \
			'map(if .id == $id then .paused = $paused else . end)' \
			"$FAKE_ACCOUNTS_FILE" > "$temporary"
		mv "$temporary" "$FAKE_ACCOUNTS_FILE"
		print -r -- "{\"success\":true}"
		;;
	PATCH\ /api/accounts/*)
		id="${request_path#/api/accounts/}"
		name="$(print -r -- "$data" | jq -er .name)"
		temporary="$(mktemp)"
		jq --arg id "$id" --arg name "$name" \
			'map(if .id == $id then .name = $name else . end)' \
			"$FAKE_ACCOUNTS_FILE" > "$temporary"
		mv "$temporary" "$FAKE_ACCOUNTS_FILE"
		print -r -- "{\"success\":true}"
		;;
	DELETE\ /api/accounts/*)
		id="${request_path#/api/accounts/}"
		temporary="$(mktemp)"
		jq --arg id "$id" 'map(select(.id != $id))' \
			"$FAKE_ACCOUNTS_FILE" > "$temporary"
		mv "$temporary" "$FAKE_ACCOUNTS_FILE"
		print -r -- "{\"success\":true}"
		;;
	*) print -u2 -- "Unhandled fake request: $method $request_path"; exit 22 ;;
esac
FAKE_CURL
	chmod 700 "$CCFLARE_CURL_BIN"
}

run_subject() {
	zsh "$subject" "$@"
}

create_fake_open
create_fake_curl
reset_accounts

help_output="$(run_subject help)"
assert_contains "$help_output" "ccflare-accounts replace"
assert_contains "$help_output" "ccflare-accounts remove"
[[ ! -s "$FAKE_REQUEST_LOG" ]] || fail "Help contacted the ccflare service"

list_output="$(run_subject list)"
assert_contains "$list_output" "Primary"
assert_contains "$list_output" "ready"
assert_contains "$list_output" "Paused old"
assert_contains "$list_output" "paused"

run_subject dashboard >/dev/null
grep -q '^http://ccflare.test$' "$FAKE_OPEN_LOG" || fail "Dashboard URL was not opened"

oauth_output="$(print 'code#state\n' | run_subject add "Claude New" claude-code)"
assert_contains "$oauth_output" "https://login.test/oauth"
assert_jq 'any(.[]; .name == "Claude New" and .tokenStatus == "valid")'
grep -q 'https://login.test/oauth' "$FAKE_OPEN_LOG" || fail "OAuth URL was not opened"

reset_accounts
ssh_output="$(print 'code#state\n' | SSH_CONNECTION="remote-host 12345 local-host 22" run_subject add "Claude SSH" claude-code)"
assert_contains "$ssh_output" "https://login.test/oauth"
assert_jq 'any(.[]; .name == "Claude SSH" and .tokenStatus == "valid")'
[[ ! -s "$FAKE_OPEN_LOG" ]] || fail "SSH OAuth flow opened a local browser"

reset_accounts
no_browser_output="$(print 'code#state\n' | CCFLARE_OPEN_BIN="$fixture_root/not-installed" run_subject add "Claude Headless" claude-code)"
assert_contains "$no_browser_output" "https://login.test/oauth"
assert_jq 'any(.[]; .name == "Claude Headless" and .tokenStatus == "valid")'

reset_accounts
print 'sk-test-only\n' | run_subject add "Anthropic API" anthropic >/dev/null
assert_jq 'any(.[]; .name == "Anthropic API" and .provider == "anthropic" and .tokenStatus == "valid")'

reset_accounts
print 'code#state\n' | run_subject replace Primary >/dev/null
assert_jq 'any(.[]; .name == "Primary" and .id == "new-id" and .paused == false)'
assert_jq 'any(.[]; .name == "Primary old 20260914-120000" and .id == "primary-id" and .paused == true)'

run_subject pause Primary >/dev/null
assert_jq 'any(.[]; .name == "Primary" and .paused == true)'
run_subject resume Primary >/dev/null
assert_jq 'any(.[]; .name == "Primary" and .paused == false)'

run_subject rename Primary Renamed >/dev/null
assert_jq 'any(.[]; .name == "Renamed")'

if print 'wrong name\n' | run_subject remove Renamed >/dev/null 2>&1; then
	fail "Removal accepted an incorrect confirmation"
fi
assert_jq 'any(.[]; .name == "Renamed")'

print 'Renamed\n' | run_subject remove Renamed >/dev/null
assert_jq 'all(.[]; .name != "Renamed")'

if CCFLARE_ALLOW_REMOTE=0 CCFLARE_BASE_URL="https://ccflare.example.com" run_subject list >/dev/null 2>&1; then
	fail "Remote ccflare URL was accepted without explicit opt-in"
fi

print -- "PASS: ccflare account manager"
