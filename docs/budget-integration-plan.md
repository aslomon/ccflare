# Adaptive account budget integration

## Bounded reconnaissance

- User: the owner of this local ccflare installation, running sustained coding workloads and needing accounts to remain usable until their quota resets.
- Visibility: existing loopback management API and dashboard. Account lookup precedes profile mutations; budget groups are local to this database and provider/model pool. Credentials never enter API responses or configuration repositories.
- Existing implementation: extend provider adapters, SQLite migrations/repositories, request-driven SessionStrategy, account management API, and existing account cards. Preserve the current 20–90 minute rotation and all unrelated working-tree changes.
- Bounds: validate external JSON with Zod, cap response/body sizes, timeout usage calls, bounded retries/backoff, finite reservation leases, bounded retained quota history, and a maximum weekly cutoff of 90%.

## Authorized requirements

Implement the approved concept directly. Default weekly cutoff is 85%; configurable cutoffs cannot exceed 90%. Apply the same policy to all active eligible accounts, including newly added accounts. Distinguish manual pause from automatic budget blocking. Restore automatic blocks only after a verified reset; never restore manual pauses. Keep provider/model/endpoint pools separate and never silently change models or billing endpoints.

## Implementation phases and acceptance criteria

1. **Domain policy and tests**: validated policy/profile/snapshot schemas; calculate remaining budget per hour and normalize by observed consumption per request work; conservative startup weights; 20–90 minute weighted sticky sessions; enforce weekly, short-window, and model-specific limits. Test boundary values, reset rollover, stale data, cold start, and invalid metadata.
2. **Persistence**: additive, idempotent SQLite migration for profiles, quota state, scheduler state, and reservations. Atomic admission protects shared subscription groups and concurrent/failover attempts. Manual pause remains independent; automatic state and session deadlines survive restart. Test with real temporary databases.
3. **Usage adapters and monitoring**: Claude OAuth usage with existing synchronized token refresh; Z.ai Coding Plan usage with strict response validation; capability detection and explicit money-budget profiles for other API accounts. Poll with timeouts/backoff; refresh closer to cutoff and after reset. Unknown usage is blocked, not interpreted as free capacity. Invalid credentials and monitoring failures remain distinguishable.
4. **Proxy integration**: filter by origin/model before selection; weight session allocation; reserve each upstream attempt, including compatibility and websocket paths. Exclude exhausted groups even if all accounts are unavailable; do not use credential passthrough to bypass an enforced policy. Preserve already-running responses and reserve their expected consumption conservatively.
5. **Management API and dashboard**: expose policy, profiles, provider snapshots, data age, forecast, next reset/session deadline, and blocking reason. Validate all mutations and prevent manual resume from overriding a budget block. Reuse existing dashboard account cards and design tokens.
6. **Reproducible installation**: update the canonical claude-config release overlay, safety defaults, wrapper, installer tests, doctor, and documentation. Include the earlier timed rotation. Keep credentials, SQLite databases, runtime JSON, host paths, and logs outside Git. Do not commit or push unless explicitly requested.
7. **Verification and activation**: failing behavior tests first, then implementation; build, typecheck, lint, repository tests, coverage and review. Verify overlay against the pinned upstream base. Stage a separate immutable release, back up config, poll readiness, and rollback on failure. Prove live policy and per-account usage through the API and an attributed provider response.

## Scheduling and safety policy

- Compute safe remaining weekly percentage divided by time until reset, then divide by the observed percentage cost per unit of request work. Bound reset urgency and account shares; avoid interpreting rounded zero deltas as zero cost.
- Use weighted fair session credits with persisted deadlines and stable tie-breaking. Change ordinary allocation at session boundaries; budget exhaustion, stale telemetry, short-window limits, and actual upstream failures can interrupt a session early.
- Reserve estimated usage before each attempt. Keep completed estimates until a later quota observation can absorb them, and keep unfinished reservations across restart until their lease expires. External usage and delayed provider accounting require additional headroom; an exact provider percentage cannot be guaranteed.
- A new account must obtain valid usage metadata before receiving quota-managed requests. Start conservatively while learning. Recognize identical credentials and allow explicit shared subscription groups; separate credentials belonging to one subscription must be grouped explicitly when no stable provider identity is available.
- Automatic weekly blocks latch until a verified new quota window. Temporary/unknown blocks clear after successful checks. Manual pause always wins. Empty pools return a structured unavailable response with retry timing.
- Z.ai Coding Plan uses its own credits, reset semantics, model multipliers, and endpoint. Pay-as-you-go uses an explicit monetary budget; there is no automatic paid fallback. Every supported model and endpoint must be verified independently.

## Dependencies, risks, and rollout

- Existing Bun, SQLite, Zod, React Query, and provider OAuth modules; no unrelated framework changes.
- HIGH: provider telemetry is delayed and some monitoring endpoints are not public stable APIs. Preserve headroom, validate strictly, fail closed when stale, and expose the failure.
- HIGH: quota credentials may refer to the same subscription. Persist group identity and reject incompatible group profiles.
- MEDIUM: long-running streams and provider errors consume uncertain quota. Keep conservative leases and account for every attempt.
- MEDIUM: deploy from dirty source/config repositories without importing unrelated WIP. Build a scoped overlay and preserve a rollback release.
- Complexity: high. This user turn explicitly authorizes both the plan and implementation; no additional approval step is needed.

## Initial integration completion evidence

All seven phases are implemented. Final source verification passed the dashboard build, workspace TypeScript checks, Biome checks, and 365 repository tests. The full client build, including the TUI, also passed during integration. The focused budget suite passed 62 tests, covering policy, adapters, persistence, account selection, response leases, monitoring, forecast warmup, and management APIs. New budget production functions remain within 40 lines and files within 300 lines.

The canonical configuration repository records activation evidence in `machine/ccflare/ROLLOUT.md`: pinned base and overlay hash, installer regression results, immutable release readiness, database integrity, dashboard checks, and attributed Claude and GLM-5.3 provider responses. Runtime account names, usage snapshots, credentials, databases, and logs remain outside Git. The versioned overlay includes the source modules, focused regression tests, API/dashboard changes, and this plan.

Claude OAuth and Z.ai Coding Plan are supported quota adapters. Other providers require an explicitly applicable local spending profile; unsupported subscription telemetry remains blocked. Forecasts remain unknown until a positive observed consumption delta is available. Provider accounting delays and external usage remain practical limits of admission control.

## Dynamic follow-up

The approved overnight follow-up is specified in [the dynamic controller plan](dynamic-budget-controller-plan.md). It replaces shared estimated-work learning and selection-time charging with independent measured windows, per-request sustainable allowance checks, pool-demand forecasts, and bounded history. The canonical rollout record identifies the active implementation and verification evidence.
