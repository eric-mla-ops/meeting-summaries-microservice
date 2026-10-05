# meeting-summaries-microservice SPEC

Status: implemented v0.1 (2026-10-05). Source: Mark Lutz / Eric Pearson sync (`MarkEric.md`). Behavioural spec of record:
`docs/feature-proposals/09-hubspot-meeting-summary-push.md` in mla-notes-sync (PR #264, Linear MAR-553); this document
specifies how that behaviour is delivered here as a NestJS service. It supersedes the earlier standalone-service draft.

## 1. Purpose

When MLA's meeting pipeline finishes an AI summary for a client meeting, push it into HubSpot as a meeting on the
participant's contact (attach to the existing HubSpot meeting, else create one). It is also the first piece of a
longer-term two-way HubSpot bridge; pulling from HubSpot, JustCall ingestion and an in-house CRM are out of scope here.

## 2. Decisions

1. Scope: `client_interactions` (customer meetings) only. Service/interview summaries are out of scope.
2. Contact key: `participant_email`. Rows without an email are skipped and logged, never guessed.
3. **Missing HubSpot contact -> provisional contact**, recorded in `hubspot_provisional_contacts`; the service creates the
   `mla_provisional` contact property (boolean checkbox) on first use and sets it. If HubSpot refuses, it falls back to
   ledger-only tracking with a warning.
4. **One shared meeting per transcript**: all participants of a recorded meeting share one HubSpot meeting associated to
   each contact; each participant's summary is its own delimited block with a `Participant:` line.
5. **Attach-or-create.**
6. Summary goes in the meeting's internal notes inside a delimited block; no custom HubSpot *meeting* properties in v1.
7. Pipedrive keeps running in the Python pipeline. This service is the HubSpot step.
8. Push is **off by default** (`HUBSPOT_SUMMARY_PUSH_ENABLED`). Slack alerting is deferred.
9. No historical flood: the sweeper needs `HUBSPOT_PUSH_SINCE`; older rows only via `/backfill` (dry-run first).

## 3. Architecture

NestJS 12, ESM, Vitest, oxlint, `@supabase/supabase-js`, native `fetch` for HubSpot, Docker Compose (dev / prod / debug).
Same conventions as `ful-ingest`.

```
src/
  sync/        pure + orchestration (framework-free, fully unit-tested)
    pure.ts            email/name/time helpers, summary block, notes merge (parity-tested vs Python goldens)
    activity-fields.ts generated from the Python ACTIVITY_FIELDS
    matcher.ts         stored id -> sibling meeting -> URL (contact, then global) -> +-window -> none
    contacts.ts        existing contact, else provisional + ledger (merged/confirmed/gone aware, ledger repair)
    sync.ts            syncInteraction (claim, contact, match, write, stamp) + runBatch
    reconcile.ts       provisional-contact review (dry-run unless apply)
  hubspot/     HubSpotClient: bounded retry on 429/5xx/network, Retry-After honored and capped
  store/       SupabaseStore: paginated, stable order (created_at, id), conditional claim
  logging/     ProcessLogger (process_log) / ConsoleLogger (dry-runs write nothing)
  summaries/   HTTP layer: ApiKeyGuard, SummariesController, SyncRunner (serial queue), SweeperService, health
  config/      env validation (fails fast, lists every missing variable)
```

`SyncRunner` serializes all pushes in the process: participants of one transcript read-modify-write the same meeting
notes, so concurrent runs could lose a block.

## 4. API

Write endpoints require `X-API-Key` (`SERVICE_API_KEY`, constant-time compare); invalid -> 401.

- `POST /summaries` `{interactionId}` xor `{transcriptId}` -> 202 `{enabled, accepted[], skipped[{id,reason}]}`. Reasons:
  `not_found`, `already_synced`, `no_email`, `no_eligible_interactions`, `push_disabled`. Rows are read from Supabase (source
  of truth), never from the request body; the push runs in the background.
- `POST /backfill` `{since (required), until?, limit?, dryRun? (default true)}` -> 200 plan (`counts`, per-row
  `contactAction`, `match`, `meetingId`, rendered `body`; zero writes) or 202 `{accepted}`. Real run while disabled -> 409.
- `POST /reconcile` `{apply? (default false)}` -> 200 `{decisions, report}`. `apply` while disabled -> 409.
- `GET /health` -> `{status:'ok'}` (open; no secrets or dependency detail).

## 5. Behaviour (summary; the Python spec has the detail)

- **Idempotent** on `client_interactions.id`; a synced row is a no-op.
- **Claim lease** (10 min, `hubspot_sync_claimed_at`, one conditional UPDATE) before any HubSpot call, so this service,
  the sweeper and the Python push can never both create a meeting for a row; released on success and failure.
- **Matching**: stored id -> a sibling participant's meeting (same `transcript_id`) -> meeting URL (on the contact, then a
  global search) -> exactly one meeting within +-`MATCH_WINDOW_MINUTES` -> create. Two or more in the window are ambiguous: never
  guessed. A date-only time is never treated as midnight.
- **Notes**: each participant's block is replaced in place on re-sync; text outside our blocks is never touched.
- **Failures**: retryable errors increment `hubspot_sync_attempts` and set `hubspot_last_error`; at `HUBSPOT_MAX_ATTEMPTS`
  the row stops being retried. A missing meeting time is a skip, not a failure. A failed ledger write fails visibly and the
  next attempt repairs it. Warnings go to `process_log`; blanks pass through, nothing is invented.
- **Reconcile**: `gone` / `confirmed` / merge only on deterministic evidence (`contact_id` -> `advisor_contacts.email` ->
  existing HubSpot contact) / `needs_review`; a failed merge leaves the row provisional; one HubSpot error never aborts the run.
- **Sweeper**: every `SWEEP_INTERVAL_MINUTES` retries unsynced rows since `HUBSPOT_PUSH_SINCE`; idle when the push is disabled.

## 6. Data

Shares migration `t549_hubspot_meeting_sync_state` with the Python push (reference copy in `supabase/migrations/`):
`client_interactions.hubspot_synced_at | hubspot_meeting_id | hubspot_contact_id | hubspot_sync_attempts |
hubspot_last_error | hubspot_sync_claimed_at` and the `hubspot_provisional_contacts` ledger (`provisional` ->
`confirmed | merged | gone`). **Not applied yet.**

## 7. Configuration

See README. Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HUBSPOT_SERVICE_KEY`, `SERVICE_API_KEY`. The service
will not start without them.

## 8. Testing

TDD: specs written first and run red. Vitest, no network: `FakeHubSpot` / `FakeStore` (src/test-utils) are injected, the HTTP
client is exercised through a fake `fetch`, the Supabase store through a recording query builder, and the HTTP layer through
`@nestjs/testing` + supertest. Parity with the Python implementation is pinned by golden fixtures generated from it
(`test/fixtures/`). Not covered: anything against live Supabase or HubSpot.

## 9. Verify against the live HubSpot portal before enabling

Standard meeting property names (`hs_timestamp`, `hs_meeting_*`, `hs_internal_meeting_notes`, `hs_meeting_outcome=COMPLETED`);
association type 200 and the default-association PUT (`/crm/v4/objects/meetings/{id}/associations/default/contacts/{id}`);
meeting search by `hs_meeting_external_url`; v4 association list and batch read; the 409 body (`Existing ID: N`); the
`mla_provisional` property-create body and its scope; the contacts merge endpoint. Open questions: does GET on a merged-away
contact id return the primary record rather than 404; does contact search match secondary emails; are HTML comments preserved
in `hs_internal_meeting_notes` after a human edits it in the UI (if stripped, the block delimiter must change); does calendar
sync store `hs_meeting_external_url` exactly as `meeting_transcripts.meeting_url`.

## 10. Open items

Custom meeting properties for the structured fields (needs Drew's approval); `salesperson_id` -> HubSpot owner mapping;
Pipedrive removal timing; service/interview summaries; which pusher (Python or this service) runs in production.
