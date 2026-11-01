# Adaptive account budgets

Managed ccflare releases route supported accounts by sustainable remaining weekly capacity. The default weekly cutoff is 85%, the configurable range is 85–90%, and admission keeps another percentage point of headroom. Provider percentages are delayed measurements; this is a conservative admission policy, not a guarantee against external usage or unusually expensive in-flight generations.

## Selection and rotation

Provider-reported weekly and short-window usage is the source of truth. Within each provider/origin/model pool, sustainable capacity is `(cutoff - headroom - used - reservations) / hours until reset / measured percentage per work unit`. Reset urgency is capped at four times the weekly baseline. Quota measurements continuously change capacity; every selection and atomic admission rechecks the latest state.

Each group has a bounded allowance, replenished by its safe percentage-per-hour rate. Quiet time replenishes at most one hour of allowance. Active requests consume it; completed usage corrects estimated consumption. A larger-than-predicted provider delta debits additional allowance, including potentially external consumption. A rounded unchanged percentage never refunds all pending work. Another compatible group with more room can interrupt a sticky session immediately. If all groups are over pace, use the least indebted group and expose the capacity deficit; hard quota guards remain mandatory.

Fair credits are charged by admitted work and corrected by measured work, not merely by selection. Temporary exclusion retains credits; actual deletion or incompatible origins remove them. Ordinary sessions last 20 minutes during learning and 55 minutes after calibration with default bounds; their duration does not apply allocation weight a second time. All sessions remain inside the configured 20–90-minute range. Deadlines survive restart and reads never prolong them. Quota, pacing, stale data, real failures, and manual pauses can interrupt them earlier. A single eligible account can continue under a reported pacing deficit.

An exploration floor of `maximum group score / (4 * eligible group count)` prevents learned weights from starving under-observed groups. Aliases split group weights and share one allowance. They do not add forecast capacity. Exploration never bypasses weekly, short-window, model, or reservation guards.

Before each HTTP, compatibility, or websocket attempt, reserve predicted work atomically. Initial work estimates use input size and maximum output. After eight correlated measurements for an account/model, apply a cautious observed ratio with an upper margin. Completed worker summaries supply input, output, cache-read, cache-write, and reasoning quantities; raw prompts and responses are not needed. Common work units weight cache reads at 0.1, cache writes at 1.25 and output at 4, then divide by 20,000. These are workload coordinates, not assumed subscription multipliers: quota cost is fitted against provider measurements independently for each window, and model-specific windows use only matching completed model work.

Weekly and five-hour baselines accumulate rounded deltas and matching work separately. No locally measured work means a usage rise is unattributed rather than proof of a high request cost. An unchanged rounded percentage can provide a nonzero one-percentage-point upper bound after a full observation interval, never a zero/free cost. Unknown plan identities keep conservative priors; a cheap peer is not copied blindly.

Streams renew leases each minute. Completed reservations remain until an observation at least one full configured polling interval later; unfinished reservations survive restart until lease expiry. Actual summaries reconcile existing reservations idempotently. Missing measurements and uncertain failures retain conservative estimates. Model-specific pending work excludes unrelated models. Exhausted pools return 503 without credential passthrough, provider changes, or paid-endpoint fallback. Websockets allow one in-flight generation per connection.

## Account onboarding and pause semantics

- New Claude/Codex OAuth and Z.ai accounts obtain provider usage before routing begins. A verified unused Claude account with no reset timestamp receives at most 0.25 estimated percentage points of bootstrap work until its window starts. It starts with conservative cost estimates and a 20-minute learning session.
- Identical credentials share a persisted group. Separate credentials for one subscription require the same explicit group ID; subscription identity cannot be inferred reliably from a usage response alone. Group profiles must agree, and identical credentials cannot split their group through the management API.
- Manual pause is the existing account `paused` flag. Automatic pause is separately persisted quota state and evaluated on every selection and admission. `/api/accounts` reports effective `paused`, plus `manualPaused` and `budget.automaticPaused`; manual resume never bypasses the budget check.
- Reaching the weekly cutoff latches a pause until a provider-confirmed different, future weekly reset. Short-window exhaustion, stale telemetry and temporary failures clear after valid fresh data permits work. Reset timestamps alone do not reactivate accounts. Manual pauses always remain paused.
- Reset timestamps within one minute identify the same window, tolerating provider rounding across polls. Such drift neither clears a weekly block nor discards learned consumption. A rollover requires a materially different future window and fresh usage.
- Poll every five minutes while idle; each active admission makes a check due within a minute. Check each minute near cutoff, under a pacing deficit or large reservation load, and again after reset. Errors back off up to 30 minutes. Data older than 15 minutes blocks admission; auth failures and unknown monetary accounting block immediately. Quota errors never become zero usage.

## Provider support

Claude OAuth uses its actual generic weekly, five-hour, and applicable model-specific windows. Token refresh shares the proxy's synchronized refresh map. The OAuth usage endpoint is provider-internal and can change.

Z.ai Coding Plan uses `CREDIT_LIMIT` unit 6/number 1 for weekly credits and unit 3/number 5 for the rolling five-hour window. Use the precise consumed/total fraction when the displayed percentage is rounded. GLM requests remain in the Z.ai origin and `glm-*` model pool, including GLM-5.3. Anthropic-compatible Z.ai upstream calls use Bearer authentication; the monitoring endpoint uses the raw key. Allowances, promotions and model multipliers come from current provider measurements, not hardcoded plan tables. Adding an API-key account now accepts an optional base URL in the dashboard.

Other API accounts require an explicit `money` profile, weekly USD allowance, a week-start timestamp and allowed models. Cost estimates use existing pricing and recorded requests through ccflare; external spend is excluded. Unknown model pricing blocks a request. There is no invented weekly percentage for an unsupported subscription. Codex OAuth uses the fixed ChatGPT subscription usage endpoint with synchronized token refresh. Weekly and five-hour windows are identified by their reported duration, not primary/secondary position; Pro may report only a weekly window. Separate meters retain their exact provider model scopes. Credits do not expand the subscription allowance, and a reached ordinary allowance blocks routing. Missing, invalid or stale telemetry never becomes zero usage. This provider-internal endpoint may change.

## Management API

- `GET /api/budgets`: effective policy and credential-free account views, provider snapshots, check age, reset, session deadline, score, learning state and blocking reason.
- `GET /api/budgets/history?accountId=<id>&before=<cursor>&limit=100`: scoped quota/selection/failure facts with exclusive pagination, at most 200 records per page. Account lookup precedes account-filtered queries. Retain 14 days subject to 50,000 history rows and 200,000 scalar attempt rows per scope. No credentials or raw content.
- `POST /api/budgets/refresh`: refresh active groups; concurrent refreshes share one run.
- `POST /api/budgets/policy`: validated full/partial-default policy. Environment policy has precedence and is returned in the response.
- `PATCH /api/accounts/:id/budget`: validated profile, after checking account existence. The dashboard exposes group, provider mode, allowed models and money-budget fields.

Example profile for a separately configured API account:

```json
{"mode":"money","groupId":"my-api-budget","models":["gpt-*"],"weeklyUsd":20,"weekAnchor":1790553600000}
```

Forecasts combine compatible-pool demand over the recent hour and a six-hour baseline, including idle time, and apply expected future group allocation. A recent spike can report a deficit even when the longer average is lower. The forecast remains unknown until at least 20 minutes of coverage and some measured local work are available. Show confidence, measurement age, reserved percentage, sustainable pace, and a capacity-deficit indicator. Confidence remains low without positive calibration samples and decays after six hours without a new sample. Adding aliases does not multiply capacity or divide a shared quota forecast. These projections describe current demand, not a guarantee of future workloads or provider accounting.
The existing management surface is loopback-only. Persisted tables include `scope_id` for database-local isolation; this does not introduce remote multi-tenant authentication. Do not expose account management to an untrusted network.

## Deployment and rollback

Unmanaged upstream installations default to disabled. Managed installation exports `CCFLARE_BUDGET_ENABLED=1`, `CCFLARE_BUDGET_CUTOFF_PERCENT=85`, and 20–90-minute rotation bounds. These environment values override local JSON changes. Configure the cutoff in the versioned installation policy and reinstall to change it safely, with a hard maximum of 90.

Budget migrations are additive and idempotent. Version 2 reads legacy state as a bootstrap but writes learning and session JSON to separate `quota_budgets_v2` and `budget_sessions_v2` tables, keeping the previous strict-schema budget release usable for rollback. Scalar reservations retain their existing schema. Build from the pinned base plus the versioned hardening patch, deploy a separate immutable directory, and retain the previous release. Readiness checks include `/health`, `/api/config`, `/api/accounts`, and `/api/budgets`. Credentials, quota databases, runtime JSON, leases, and logs remain outside Git. A rollback to the previous release leaves manual pauses intact and ignores the additive budget tables.

Provider references: [Z.ai Coding Plan](https://docs.z.ai/devpack/overview), [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3), and the [official usage-query implementation](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs).
