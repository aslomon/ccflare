# Dynamic budget controller

## Bounded reconnaissance

- User: the local installation owner, starting and stopping parallel coding workloads throughout the day.
- Visibility: the existing loopback account API and dashboard. Read account identity before mutations; persist only database-scoped, credential-free quota/work metadata.
- Existing implementation: extend BudgetControl, provider quota observations, the usage worker's completed-request summaries, SQLite budget repositories, and the current account cards. Preserve manual pauses, provider/model pools, and the canonical installer.
- Limits: 85% default and 90% maximum weekly cutoff; fresh telemetry and atomic reservations; ordinary sessions between 20 and 90 minutes; earlier quota/pacing interruptions; 14-day metadata retention with row caps and bounded paginated API reads.

## Authorized requirements

Implement the overnight analysis improvements now. Changing concurrency and demand must affect every admission and selection, without waiting for a fixed session timer. Quiet periods replenish a bounded allowance; sudden bursts consume it faster and move traffic to other compatible accounts. A compatible pool that cannot sustain demand must report its deficit. Never silently change provider, model, or billing endpoint.

## Implementation and acceptance

1. Keep independent per-window usage/work baselines, costs, sample counts, and confidence. Rounded zero deltas accumulate matching work; resets discard the previous window's baseline. External or delayed usage remains uncertainty, never free capacity.
2. Separate estimated in-flight work from measured completed work. Correlate existing worker summaries with persisted attempt IDs on HTTP, compatibility, and websocket paths. Use input/output/cache/reasoning metadata; learn account/model prediction ratios cautiously. Missing or failed measurements keep their conservative reservation.
3. Retain scheduling credits across temporary exclusion and debit admitted work, correcting it when actual work arrives. Session duration does not independently multiply the same allocation weight. Sticky deadlines persist and reads never extend them.
4. Maintain a bounded quota allowance replenished by sustainable remaining points/hour. Reevaluate it for each incoming request and each atomic admission. Switch early when another eligible group has allowance; preserve hard quota guards and show overload when only deficit groups remain.
5. Forecast pool demand from a recent hour and a six-hour baseline, including idle time, and distribute future demand by current compatible capacity. Expose measured versus reserved usage, safe pace, deficit, confidence, and measurement age. Retain quota and selection reasons through a bounded, scoped REST history endpoint.
6. Add failing regressions for independent windows, quantization, resets, actual cache-heavy usage, idempotent completion, shared groups, preserved credits, sudden parallel demand, quiet recovery, and persistent deadlines. Build, types, lint, tests, review, then stage and activate the immutable canonical release with rollback checks and attributed provider smoke requests.

## Measurement limits

Common work units use token metadata to make local requests comparable; API prices are not assumed to equal subscription quota multipliers. Provider/account costs are fitted against independent quota deltas; model-specific quota windows use their own matching model work. Prediction ratios do not establish a subscription tier. New or unknown plans retain conservative priors and bounded exploration.

Provider accounting can lag and include external traffic. The controller cannot guarantee a provider's exact percentage or create more aggregate capacity. History starts at activation; previously unrecorded overnight quota snapshots cannot be reconstructed.

The implementation is authorized in this conversation. No additional confirmation, commit, or push is part of this change.
