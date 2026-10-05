# meeting-summaries-microservice

NestJS service that pushes Marine Layer Advisors' AI meeting summaries (`client_interactions`) into HubSpot:
each recorded client meeting becomes **one shared HubSpot meeting** associated to every participant's contact, with
each participant's summary as its own block in the meeting notes. A participant with no HubSpot contact gets a
**provisional contact** that can later be reviewed, merged or confirmed. Design and behaviour: [SPEC.md](SPEC.md).

This is a Docker Compose project. It is the NestJS twin of the Python push in `mla-notes-sync`
(`scripts/transcript_processing/hubspot_summary_sync.py`, PR #264): same tables, same columns, same behaviour,
verified against golden output generated from the Python code.

> **Safety switch.** `HUBSPOT_SUMMARY_PUSH_ENABLED` is **off** by default. Enabling it writes to the production HubSpot
> CRM and creates provisional contacts. While off, `POST /summaries` acknowledges and does nothing, real backfills and
> `reconcile` with `apply` return 409, and the sweeper is idle. Dry-runs still work.

## Quick start (Docker Compose)

```bash
cp .env.example .env          # fill in the four required values (see Configuration)
docker compose up --build     # dev: hot reload, source bind-mounted
curl localhost:3000/health    # {"status":"ok"}
```

Production-style run (compiled build, no bind-mount, restarts on failure):

```bash
docker compose -f compose.yaml -f compose.prod.yaml up --build -d
```

Debug (Node inspector on `127.0.0.1:9229`): `docker compose -f compose.yaml -f compose.debug.yaml up --build`.

Without Docker: `npm install && npm run start:dev`. The service refuses to start unless the required variables are set.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | required | Same Supabase project as mla-notes-sync (service role; server-side only) |
| `HUBSPOT_SERVICE_KEY` | required | Bearer token. Scopes: contacts read/write, meetings read/write, and `crm.schemas.contacts.write` (optional, to create the `mla_provisional` property) |
| `SERVICE_API_KEY` | required | Shared secret callers send as `X-API-Key` |
| `HUBSPOT_SUMMARY_PUSH_ENABLED` | `false` | Master switch (see above) |
| `HUBSPOT_PUSH_SINCE` | unset | Earliest `created_at` the sweeper may push; the sweeper never runs unscoped |
| `MATCH_WINDOW_MINUTES` | `30` | Time-window match for an existing HubSpot meeting |
| `HUBSPOT_MAX_ATTEMPTS` | `5` | Failed attempts before a row stops being retried (explicit `interactionId` calls bypass it) |
| `SWEEP_INTERVAL_MINUTES` | `60` | Retry sweeper; `0` disables it |
| `PORT` | `3000` | Compose publishes it on the host |

## API

Write endpoints require the `X-API-Key` header (constant-time compare). `GET /health` is open and minimal.

| Endpoint | What it does |
|---|---|
| `POST /summaries` `{interactionId}` or `{transcriptId}` | Called by MLA Notes Sync when a summary is ready. Reads the rows from Supabase, answers **202** `{enabled, accepted[], skipped[{id,reason}]}` immediately and pushes in the background. Re-posting a synced id is a no-op. |
| `POST /backfill` `{since, until?, limit?, dryRun?}` | `since` (YYYY-MM-DD) is required. **Dry-run by default**: returns the plan per row (contact action, match, rendered body) and writes nothing. `dryRun:false` pushes in the background (202). |
| `POST /reconcile` `{apply?}` | Reviews provisional contacts: `confirmed` / `merged` / `gone` / `needs_review`. Dry-run unless `apply:true`; merges only on deterministic evidence (`contact_id` -> `advisor_contacts.email` -> existing HubSpot contact), never on name similarity. |
| `GET /health` | `{"status":"ok"}` |

```bash
curl -X POST localhost:3000/backfill -H 'X-API-Key: $SERVICE_API_KEY' -H 'content-type: application/json' \
     -d '{"since":"2026-10-01"}'                       # dry-run plan
curl -X POST localhost:3000/summaries -H 'X-API-Key: $SERVICE_API_KEY' -H 'content-type: application/json' \
     -d '{"transcriptId":"<uuid>"}'
```

## Database

Shares migration `t549_hubspot_meeting_sync_state` with the Python push (reference copy in
`supabase/migrations/`; the authoritative file is in mla-notes-sync). It adds the `hubspot_*` columns to
`client_interactions` (including the `hubspot_sync_claimed_at` lease) and the `hubspot_provisional_contacts` ledger.
**It is not applied yet.** Run the read-only schema checks listed in mla-notes-sync PR #264 first.

Run **one** pusher in production. Both implementations claim a row with the same conditional update before touching
HubSpot, so a double push is prevented, but running both is redundant: set `HUBSPOT_SUMMARY_PUSH_ENABLED=false` on the
one you are not using.

## Development

```bash
npm test          # vitest (202 tests; no network, no Supabase, no HubSpot)
npm run lint      # oxlint
npm run build
```

Parity with Python is enforced by golden fixtures in `test/fixtures/` (summary blocks, notes merging, time/name/email
parsing, generated by running the Python implementation); `src/sync/activity-fields.ts` is generated from the Python
`ACTIVITY_FIELDS`. If the Python formatting changes, regenerate them and the specs show exactly what moved.

## Rollout checklist

1. Apply migration t549 (after the read-only schema checks).
2. Contract-check HubSpot with a test contact: standard meeting property names, association type 200, the default
   association PUT, meeting search by URL, the property-create body, contact merge scope (SPEC.md section 9).
3. `POST /backfill {"since": "..."}` (dry-run) and review the plan.
4. Set `HUBSPOT_PUSH_SINCE`, then `HUBSPOT_SUMMARY_PUSH_ENABLED=true`.
5. Review provisional contacts with `POST /reconcile` (dry-run) before any `apply`.
