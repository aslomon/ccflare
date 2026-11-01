# Local workers through LM Studio

## Bounded reconnaissance and acceptance

- User: the Cockpit dispatches bounded analysis, mechanical implementation and tests to local workers to conserve subscription capacity.
- Access: existing local CCflare management boundary; a separate `lmstudio` provider/account prevents cloud credential forwarding and quota attribution. This is workstation infrastructure, not Eventium tenant data storage. Worker permissions and worktree isolation remain mandatory.
- Reuse: native Anthropic passthrough, usage worker, account metadata, existing budget profiles and Claude Code harness. No second inference proxy or new scheduler.
- Limits: two concurrent local inference requests; 100,000-token client window including output; initial brief target below 40,000 tokens; bounded request body and execution deadline. Full two-times-100k occupancy is not proven.

## Implementation plan

1. Register LM Studio independently, normalize thinking on/off, preserve native tool calls and streaming, count final usage, record zero variable API fees.
2. Add local capacity mode without fictitious weekly quota; queue incidental harness calls within bounded limits and release slots on completion, failure and cancellation.
3. Provide a scoped Claude Code worker launcher and Cockpit instructions, preserving the model preference table, two productive lanes and native subagents.
4. Verify unit/integration behavior, then real requests through CCflare and two useful concurrent workers. Activate only a verified immutable runtime, preserving existing source changes.

Acceptance: local provider/account/model attribution, zero API cost, no Claude quota access, explicit reasoning behavior, no silent cloud fallback, two-slot admission and usable worker reports. Local power/hardware costs are not included in zero API fees.

## Worker interface

`python3 scripts/local-worker.py --status` checks the actual CCflare route and model list, plus the two cooperating worker locks. It is advisory; inference admission is independently limited to two requests in CCflare. Do not dispatch if unavailable.

```
python3 scripts/local-worker.py --dir /path/to/worktree \
  --prompt /path/to/self-contained-brief.md --output /path/to/new-report-dir \
  --thinking on --effort low
```

Use `--read-only` for scouts. Normal workers retain Claude Code's native tool/subagent harness and `auto` permissions. No global settings are changed. The output directory must not exist; it receives events, stderr, a summary and the final report. A zero CLI exit alone does not count as success: a successful final result is required. Exit 1 means failure/unavailability and the package stays pending for deliberate reassignment. Cloud fallback is never automatic inside this local route.

The brief cap is 120,000 UTF-8 bytes, not a tokenizer measurement; keep the complete initial request (instructions, tools and files included) below the agreed approximately 40k-token starting target. The 100k client window includes subsequent history and generated tokens. Auto-compaction belongs to Claude Code, not LM Studio; restarting from a compact handoff remains the recovery when compaction fails. Two overlapping modest contexts have been tested; two full 100k contexts are not a memory-capacity guarantee.

`x-ccflare-local-thinking: on|off` is a per-request override consumed by CCflare. Without an override, explicit disabled thinking removes conflicting effort, effort-only requests enable visible reasoning, and requests without either disable reasoning. Existing native tool blocks and other payload fields pass through. Streaming final input/output counts override preliminary counts. Local costs mean zero variable API charges; hardware/power costs and Claude Code's displayed cloud-equivalent estimates are excluded.

Read-only workers expose only Read, Glob and Grep and deny other tool requests without a model-based permission classifier. Normal implementation workers retain auto permissions and native subagents. Additional local inference calls queue for up to five minutes (at most eight waiting); two execute concurrently. The total worker deadline includes queue time.
