# meeting-summaries-microservice SPEC

Status: draft v0.1 (2026-10-05). Source: Mark/Eric sync (`MarkEric.md`) + read of `mla-notes-sync` (`push_to_pipedrive.py`, `docs/reference/meeting-transcript-pipeline.md`, `gbrain/meeting-transcript-schema.md`, `docs/reference/hubspot-notes-sync.md`).
Items marked **[ASSUMPTION]** were not explicitly decided; they are the defaults I will build unless corrected.

## 1. Purpose

When MLA's meeting pipeline finishes an AI summary for a client meeting, push that summary into HubSpot as a **meeting on the contact**: attach to the HubSpot meeting if one already exists, otherwise create it. This replaces the legacy Pipedrive push (`scripts/transcript_processing/push_to_pipedrive.py`) as the CRM step, and is the first piece of a longer-term two-way HubSpot bridge (a step toward an in-house CRM).

## 2. Scope

### In scope (v1)
- NestJS service, backend only, no UI.
- `client_interactions` rows (category `customer`) → HubSpot meeting on the matching contact.
- Contact resolution by email, creating a minimal contact if missing.
- Meeting matching (stored ID → URL → time window → create).
- Persisted sync state with retry/backoff.
- Manual `/backfill` endpoint with dry-run.
- Adapter interface with `service_interactions` and `interview_interactions` **stubbed and disabled** behind a feature flag (§6.4).

### Out of scope (v1)
- Pulling anything from HubSpot into Supabase (JustCall ingestion, object/schema mirroring, in-house CRM). Mark's follow-up items; separate specs.
- Internal meetings (`internal_meeting_notes`); interview/service push (stubbed only).
- Slack/email alerting (deferred; failures are persisted and logged only).
- UI, queue/Redis, claude partner-program research, Supabase prod password-reset issue.
- Removing the Pipedrive push from Notes Sync (runs in parallel until Mark says otherwise).

## 3. Context (from the source repo)

- Pipeline: Recall.ai `transcript.done` webhook → `mla-notes-sync` FastAPI on Railway → LLM extraction → rows in category tables → today pushes to Pipedrive and emails MLA participants. A 2 AM nightly job is a safety net.
- Summaries are **per participant** (6 advisors on one call → 6 `client_interactions` rows).
- `client_interactions` (38 cols): only `id` and `interaction_date` NOT NULL; `contact_id` and `participant_email` are **often null**. FKs: `transcript_id → meeting_transcripts.id`, `contact_id → advisor_contacts.contact_id`, `salesperson_id → salesteam.salesperson_id`.
- `meeting_transcripts` has `meeting_url`, `meeting_title`, `meeting_date`, `participants` (jsonb).
- Pipedrive push matched Person by `participant_email` and stamped `pipedrive_synced_at`. Skips rows with null email. No 429 handling.
- HubSpot already receives pushes from Notes Sync (Structured Note custom object, trade economics, advisor notional on Contacts keyed by email). Auth is a HubSpot **Service Key** sent as `Authorization: Bearer <key>` (env `HUBSPOT_SERVICE_KEY` in Notes Sync). Mark is sending the key.
- Known hazard: duplicate webhook/nightly processing can produce duplicate `client_interactions` rows → our idempotency must key on interaction `id` (and not double-push on re-delivery).

## 4. Stack and conventions

Same as `ful-ingest`: NestJS 12, ESM, TypeScript, Vitest, oxlint + prettier, `@nestjs/config` with validated env, `@supabase/supabase-js`, Dockerfile, deployed on **Railway** (service named meaningfully, e.g. `meeting-summaries-hubspot`). Built test-first (red → green → refactor), each slice in §10 starts with failing tests. HubSpot HTTP via native `fetch` behind a thin gateway class (mockable). **[ASSUMPTION]** no HubSpot SDK.

```
src/
  summaries/     POST /summaries controller, orchestration service
  hubspot/       gateway (contacts, meetings, associations, search), rate-limit/retry
  mapping/       interaction → meeting body + properties (ported from ACTIVITY_FIELDS)
  matching/      meeting matcher (§6.3)
  sync/          state persistence, retry sweeper, backfill
  sources/       adapter per category (client enabled; service/interview stubs)
  supabase/      gateway (reads client_interactions + meeting_transcripts, writes sync state)
  auth/          shared-secret guard
  config/        env validation
supabase/migrations/   SQL for sync-state columns (applied by Eric/Mark in Notes Sync)
```

## 5. API

### `POST /summaries`
Auth: header `X-API-Key: <SERVICE_API_KEY>`, constant-time compare; 401 otherwise.

Body (exactly one):
```json
{ "interactionId": "<uuid>" }
{ "transcriptId": "<uuid>" }   // all unsynced client_interactions for that transcript
```
Behavior: load rows from Supabase (source of truth, not the request body), validate, enqueue in-process, respond **202** `{ accepted: [ids], skipped: [{id, reason}] }` immediately. Processing is async in-process (no Redis). Re-posting an already-synced id is a no-op (`skipped: already_synced`).

### `POST /backfill`
Same auth. Body: `{ "since": "YYYY-MM-DD", "until"?: "YYYY-MM-DD", "limit"?: n, "dryRun": true }`. `dryRun` defaults to **true**. Dry-run returns, per row, the resolved contact action (`found|create|no_email`), the match result (`stored|url|window|create`) and the rendered body, with no HubSpot writes. Real run requires `dryRun:false` and a `since` (no unbounded backfill).

### `GET /health`
Unauthenticated; liveness only (no secrets, no DB detail).

## 6. Behavior

### 6.1 Eligibility
A `client_interactions` row is eligible when `hubspot_synced_at IS NULL`, `participant_email IS NOT NULL`, and it is not in a terminal-failed state. Rows with null email are marked `skipped_no_email` (not retried).

### 6.2 Contact resolution
1. Search HubSpot contacts by email (`email EQ`, case-insensitive; lowercased/trimmed).
2. Found → use its id.
3. Not found → **create** a minimal contact: `email`, and `firstname`/`lastname` split from `participant_name` (best effort; email only if no name). **[ASSUMPTION]** also set nothing else (no lifecycle stage, no owner) so Drew's automations decide.
4. Create-contact races (409 on duplicate email) → re-search and use the existing id.

### 6.3 Meeting matching (first hit wins)
1. **Stored ID**: `client_interactions.hubspot_meeting_id` set (re-push/re-sync) → update that meeting.
2. **Meeting URL**: `meeting_transcripts.meeting_url` equals the HubSpot meeting's `hs_meeting_external_url` for meetings associated to the contact.
3. **Time window**: contact's meetings with `hs_meeting_start_time` within ±`MATCH_WINDOW_MINUTES` (default **30**) of `meeting_transcripts.meeting_date`. Exactly one candidate → attach; 2+ candidates → **do not guess**, create new (log `ambiguous_window`).
4. **Create** a new meeting associated to the contact.

"Attach" = write our summary into the existing meeting's internal notes without overwriting existing human-entered content (§6.5).

### 6.4 Source adapters
```ts
interface SummarySource {
  readonly category: 'customer' | 'service' | 'interview';
  readonly enabled: boolean;                 // flag-controlled
  fetchEligible(ids): Promise<Row[]>;
  toContactEmail(row): string | null;
  toMeeting(row, transcript): MeetingPayload;
}
```
Only `customer` (`client_interactions`) is enabled. `service_interactions` (counterparty_contacts) and `interview_interactions` (candidate_email) adapters exist as disabled stubs; `ENABLE_SERVICE_SYNC` / `ENABLE_INTERVIEW_SYNC` default false. Their HubSpot destination is undecided (open question §11).

### 6.5 HubSpot field mapping (client meetings)
Create/attach on the HubSpot **meetings** object (`crm/v3/objects/meetings`), associated to the contact.

Standard properties **[ASSUMPTION]** (verify against live portal):
| HubSpot | Source |
|---|---|
| `hs_timestamp` / `hs_meeting_start_time` | `meeting_transcripts.meeting_date` (fall back `interaction_date`) |
| `hs_meeting_end_time` | omitted unless duration known |
| `hs_meeting_title` | `meeting_title`, else `Meeting: {participant_name} - {call_type}` (Pipedrive subject logic) |
| `hs_meeting_outcome` | `COMPLETED` |
| `hs_meeting_external_url` | `meeting_transcripts.meeting_url` (when creating) |
| `hs_internal_meeting_notes` | formatted summary (below) |
| `hubspot_owner_id` | from `salesperson_id` → owner map, **[ASSUMPTION]** only if a mapping exists; otherwise unset |

Formatted summary: port `ACTIVITY_FIELDS` / `_format_*` from `push_to_pipedrive.py` verbatim in behavior (all labelled fields, arrays comma-joined, competitor mentions and communication prefs formatted, `html.escape` on every value, empty fields omitted). When attaching to an existing meeting, **append** under a delimited block `<!-- mla-summary:{interactionId} -->…<!-- /mla-summary -->` and replace that block on re-sync; never touch text outside it.

Custom properties ("Both"): **[ASSUMPTION]** the service creates a property group `MLA Meeting Summary` and one text property per field idempotently at startup (`ENSURE_HUBSPOT_PROPERTIES=true`; needs the `crm.schemas.meetings.write` scope), e.g. `mla_call_type`, `mla_call_sentiment`, `mla_relationship_temp`, `mla_likelihood_to_proceed`, `mla_next_steps`, `mla_next_touchpoint`, `mla_pain_points`, `mla_objections`, `mla_desired_outcomes`, `mla_capabilities_discussed`, `mla_action_items_mla`, `mla_action_items_client`, `mla_red_flags`, etc. Long text → multi-line text. Drew should approve the property list before enabling in production. If the scope is missing, the service logs it and falls back to body-only.

### 6.6 Sync state
Migration (written by us, applied in Notes Sync's Supabase), all on `client_interactions`:
```sql
ALTER TABLE client_interactions
  ADD COLUMN IF NOT EXISTS hubspot_synced_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hubspot_meeting_id    TEXT,
  ADD COLUMN IF NOT EXISTS hubspot_contact_id    TEXT,
  ADD COLUMN IF NOT EXISTS hubspot_sync_status   TEXT,   -- pending|synced|skipped_no_email|retrying|failed
  ADD COLUMN IF NOT EXISTS hubspot_sync_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hubspot_next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hubspot_last_error    TEXT;
```
(Optionally also cache `hubspot_contact_id` back on `advisor_contacts` for the later two-way work, **[ASSUMPTION]** not in v1.)

### 6.7 Failure handling
- Transient (HTTP 429, 5xx, network): exponential backoff with jitter (e.g. 1m, 5m, 30m, 2h, 6h), honoring `Retry-After`; status `retrying`, `hubspot_next_retry_at` set.
- Permanent (4xx other than 429, validation, no email): status `failed`/`skipped_no_email`, `hubspot_last_error` recorded, no retry.
- After `MAX_ATTEMPTS` (default 6) → `failed`.
- A `@nestjs/schedule` sweeper (every 5 min) picks up `retrying` rows whose `next_retry_at <= now()`. It claims a row atomically (conditional update on `hubspot_sync_attempts`/status) so webhook + sweeper + a second replica can't double-process.
- Partial failure (contact ok, meeting create fails): persist `hubspot_contact_id` so retry skips contact work.
- Alerting is **deferred**; failures are visible via `hubspot_sync_status='failed'` and structured logs. (Add Slack later.)
- HubSpot client throttles to stay under the portal's rate limit (default ≤ 8 req/s, configurable); contact search is the hot path.

### 6.8 Idempotency
Key = `client_interactions.id`. Safe to call `POST /summaries` repeatedly. Meeting create is guarded by conditional status transition (`pending→syncing`) and post-create persistence of `hubspot_meeting_id`; if the process dies between HubSpot create and the DB write, the next attempt recovers via matching step 2/3 rather than creating a duplicate.

## 7. Configuration (env, validated at boot)

| Var | Notes |
|---|---|
| `PORT` | default 3000 |
| `SERVICE_API_KEY` | shared secret for inbound calls |
| `HUBSPOT_SERVICE_KEY` | Bearer token; scopes: contacts read/write, meetings (`crm.objects.meetings` — verify exact scope names) read/write, `crm.schemas.meetings.write` for property setup |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | read interactions/transcripts, write sync state |
| `MATCH_WINDOW_MINUTES` | default 30 |
| `MAX_ATTEMPTS`, `HUBSPOT_RPS` | retry/rate defaults above |
| `ENSURE_HUBSPOT_PROPERTIES` | default false in prod until approved |
| `ENABLE_SERVICE_SYNC`, `ENABLE_INTERVIEW_SYNC` | default false |

No secrets in the repo or in logs; the Service Key must never be logged. Add `.env.example`.

## 8. Notes Sync integration (separate small PR in `mla-notes-sync`, not part of this repo)
After `client_interactions` rows are written (webhook path in `api/meeting_summary_pipeline.py`, and nightly step 3), call `POST /summaries {transcriptId}` with `X-API-Key`. Failure to reach this service must not fail the pipeline. Pipedrive push stays in place until cutover is decided.

## 9. Testing
- Unit: mapping/formatting parity with the Python `ACTIVITY_FIELDS` output (golden fixtures), email normalization, name splitting, backoff schedule, matcher decision table (stored/URL/window/ambiguous/none).
- Integration (mocked HubSpot via a fake gateway; Supabase via a fake gateway, optional live Supabase test behind `RUN_SUPABASE_IT=1` like ful-ingest): full flow per outcome (create contact+meeting, attach to existing, 429 then success, permanent 4xx, race on contact create, duplicate webhook).
- HubSpot contract test script (manual, `RUN_HUBSPOT_IT=1`) against a sandbox/test contact only.
- Synthetic fixtures only; no real client data committed.

## 10. Build slices (each starts with failing tests)
1. Scaffold, config validation, auth guard, `/health`.
2. Mapping/formatter (port of Pipedrive logic) + golden tests.
3. HubSpot gateway: contact search/create, meeting search/create/update, associations, retry/rate-limit.
4. Matcher.
5. Supabase gateway + migration SQL + sync-state transitions.
6. `POST /summaries` orchestration (async), idempotency.
7. Retry sweeper.
8. `/backfill` with dry-run.
9. Custom-property bootstrap (flagged).
10. Dockerfile/Railway config, README, `.env.example`, Notes Sync integration snippet.

## 11. Open questions / not yet confirmed
1. **HubSpot Service Key + scopes**: Mark to send; need meeting scopes confirmed. A sandbox or test contact for the contract test would help.
2. **Custom properties**: does Drew approve creating them (and the exact list)? Until then body-only works.
3. **Owner mapping** (`salesperson_id` → HubSpot owner id): wanted, or leave unset?
4. **Service/interview destination in HubSpot** (stubbed until decided).
5. **Missing email rows**: skipped for now; is a fallback via `contact_id → advisor_contacts.email` desired? (Cheap to add; I lean yes.)
6. **Pipedrive cutover**: when to remove the Pipedrive push.
7. Whether `meeting_transcripts.meeting_url` reliably matches what HubSpot stores in `hs_meeting_external_url` (to be checked against real data during dry-run).
8. Whether Notes Sync's Supabase migration can be applied by Eric, or only Mark.
