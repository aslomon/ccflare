# Timed account rotation

The local ccflare operator uses this to distribute ongoing provider traffic across
the existing account pool. Provider compatibility and pause/rate-limit filtering
are checked before selection. This extends `SessionStrategy`, its provider-scoped
repository queries and existing session persistence. No new data access or API
permissions are introduced. Configuration is validated with Zod; windows must be
positive integer milliseconds, ordered, and at most one day.

## Requirements and acceptance criteria

- Keep a provider account preferred for a varying window between 20 and 90 minutes.
- On the first request at or after the deadline, select the next available account.
- Visit every available account in stable creation order before wrapping around.
- Skip paused and rate-limited accounts immediately, retaining ordered failover.
- Keep provider pools separate and preserve session deadlines across restarts.
- Leave already running HTTP requests/streams on the account they selected.
- Preserve the legacy behavior on installations without rotation configuration.

## Configuration

Add to the existing ccflare JSON configuration:

```json
{
  "session_rotation_min_ms": 1200000,
  "session_rotation_max_ms": 5400000
}
```

Restart the service after changing these settings. `GET /api/config` reports the
effective `sessionRotation` bounds. `sessionDurationMs` remains the legacy usage
counter window; it does not determine the rotation deadline when rotation is enabled.

The deadline uses stable pseudorandom jitter derived from the existing persisted
account ID and session start. It varies per session without losing the deadline
on restart. Rotation is driven by incoming requests; idle services do not consume
provider calls or start a background timer. If only one account is available, its
session is renewed. Different model mixes and request volumes mean equal turns
do not guarantee equal tokens or equal subscription utilization.

## Verification

Clock-controlled tests cover the 20/90 minute bounds, full account cycles,
independent restart timelines, provider isolation, skipped accounts and fallback
ordering. A temporary SQLite integration test covers provider filtering and a
database reopen. Configuration tests cover API reporting and invalid bounds.

Activation uses a separate release containing only the reviewed source changes,
retaining the previous release and a configuration backup for rollback.
