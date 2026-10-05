-- REFERENCE COPY. The authoritative file lives in mla-notes-sync (migrations/t549_..., PR #264);
-- this service and the Python push share the same tables and columns. Not applied automatically.
-- Migration: t549 HubSpot meeting sync state
-- Ticket: MAR-553
-- Created: 2026-10-05
-- =============================================================================
--
-- WHY
--
--   Customer meetings land in client_interactions and are pushed to Pipedrive
--   as Activities (pipedrive_synced_at, migration 012). We are adding a second
--   CRM target: each customer interaction is also pushed to HubSpot as a
--   Meeting engagement associated with the participant's HubSpot contact.
--
--   That push needs its own state, separate from Pipedrive's, because the two
--   CRMs succeed and fail independently:
--
--     - hubspot_synced_at     NULL = not yet pushed. Same contract as
--                             pipedrive_synced_at, so the unsynced scan is the
--                             same shape for both pushers.
--     - hubspot_meeting_id    The HubSpot meeting object id, so a retry can
--                             update instead of creating a duplicate meeting.
--     - hubspot_contact_id    The HubSpot contact the meeting was associated
--                             with (matched or provisional).
--     - hubspot_sync_attempts Failed-attempt counter, so a row that keeps failing can
--                             be capped and surfaced instead of retried forever.
--     - hubspot_last_error    Last failure message, for triage.
--     - hubspot_sync_claimed_at
--                             Short lease stamped by a conditional UPDATE
--                             before any HubSpot call, so the webhook-path
--                             push and the nightly push cannot both create a
--                             HubSpot meeting for the same interaction.
--
--   When a participant email has no HubSpot contact, the pusher creates a
--   provisional one so the meeting is not dropped. Those contacts can be wrong
--   (a personal address for someone who already exists under a work address,
--   a typo from the transcript), so every one we create is recorded in
--   hubspot_provisional_contacts. That ledger is the work queue for later
--   review: confirm the contact, record that it was merged into the right one,
--   or mark it gone if it was deleted in HubSpot. It also stops us creating a
--   second provisional contact for the same email (unique on lower(email)).
--
-- RLS POSTURE
--
--   Same as t522 / t543: the new table is written and read only by
--   mla-notes-sync on the service role. No application reads it. So RLS is on,
--   anon and authenticated hold nothing, and there is no policy for them.
--   service_role bypasses RLS and needs no policy. client_interactions already
--   has this posture from t522 and is not touched here beyond new columns.
--
-- Conventions mirror 012, t293 and t522: IF NOT EXISTS guards, COMMENT ON for
-- every new column and table, idempotent throughout. No triggers, no functions.
-- Run this in the Supabase SQL Editor.
-- =============================================================================


-- =============================================================================
-- Part 1: client_interactions HubSpot sync columns
-- =============================================================================

ALTER TABLE public.client_interactions
    ADD COLUMN IF NOT EXISTS hubspot_synced_at     TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.client_interactions
    ADD COLUMN IF NOT EXISTS hubspot_meeting_id    TEXT;
ALTER TABLE public.client_interactions
    ADD COLUMN IF NOT EXISTS hubspot_contact_id    TEXT;
ALTER TABLE public.client_interactions
    ADD COLUMN IF NOT EXISTS hubspot_sync_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.client_interactions
    ADD COLUMN IF NOT EXISTS hubspot_last_error    TEXT;
ALTER TABLE public.client_interactions
    ADD COLUMN IF NOT EXISTS hubspot_sync_claimed_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.client_interactions.hubspot_synced_at IS
'Timestamp when this interaction was pushed to HubSpot as a Meeting engagement. NULL means not yet synced. Mirrors pipedrive_synced_at. See MAR-553.';

COMMENT ON COLUMN public.client_interactions.hubspot_meeting_id IS
'HubSpot meeting object id created for this interaction. Set on the first successful create so retries update the existing meeting instead of creating a duplicate. NULL until created.';

COMMENT ON COLUMN public.client_interactions.hubspot_contact_id IS
'HubSpot contact id the meeting was associated with: either an existing contact matched by participant email, or a provisional contact recorded in hubspot_provisional_contacts. NULL until resolved.';

COMMENT ON COLUMN public.client_interactions.hubspot_sync_attempts IS
'Number of FAILED HubSpot push attempts for this interaction (not incremented on success). Lets the pusher cap retries on a row that keeps failing. Starts at 0.';

COMMENT ON COLUMN public.client_interactions.hubspot_last_error IS
'Error message from the most recent failed HubSpot push attempt. NULL if the last attempt succeeded or no attempt has been made.';

COMMENT ON COLUMN public.client_interactions.hubspot_sync_claimed_at IS
'Short lease (the pusher uses 10 minutes) stamped by a conditional UPDATE (WHERE id = ? AND hubspot_synced_at IS NULL AND (hubspot_sync_claimed_at IS NULL OR hubspot_sync_claimed_at < now() - lease)) before any HubSpot call, so the webhook-path push and the nightly push cannot both create a HubSpot meeting for the same interaction. Cleared (NULL) by the pusher on success or failure; a crashed worker''s claim simply expires. NULL means unclaimed.';

-- Partial index for the unsynced scan: the pusher selects rows with
-- hubspot_synced_at IS NULL ordered by created_at. Synced rows are the vast
-- majority over time and are excluded from the index entirely.
CREATE INDEX IF NOT EXISTS idx_client_interactions_hubspot_unsynced
    ON public.client_interactions (created_at)
    WHERE hubspot_synced_at IS NULL;


-- =============================================================================
-- Part 2: hubspot_provisional_contacts ledger
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.hubspot_provisional_contacts (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                           TEXT NOT NULL,
    hubspot_contact_id              TEXT NOT NULL,
    participant_name                TEXT,
    source_interaction_id           UUID REFERENCES public.client_interactions(id) ON DELETE SET NULL,
    source_contact_id               UUID REFERENCES public.advisor_contacts(contact_id) ON DELETE SET NULL,
    status                          TEXT NOT NULL DEFAULT 'provisional',
    merged_into_hubspot_contact_id  TEXT,
    resolution_note                 TEXT,
    last_error                      TEXT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at                     TIMESTAMPTZ,
    CONSTRAINT hubspot_provisional_contacts_status_check
        CHECK (status IN ('provisional', 'confirmed', 'merged', 'gone')),
    CONSTRAINT hubspot_provisional_contacts_email_normalized_check
        CHECK (email = lower(btrim(email)))
);

-- One provisional contact per email address.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hubspot_provisional_contacts_email_lower
    ON public.hubspot_provisional_contacts (lower(email));

CREATE INDEX IF NOT EXISTS idx_hubspot_provisional_contacts_status
    ON public.hubspot_provisional_contacts (status);

COMMENT ON TABLE public.hubspot_provisional_contacts IS
'Ledger of provisional HubSpot contacts created by the meeting pusher because no HubSpot contact existed for a participant email. Each row is reviewed later and confirmed, recorded as merged into the correct contact, or marked gone. One row per email (unique on lower(email)). Service role only. See MAR-553.';

COMMENT ON COLUMN public.hubspot_provisional_contacts.id IS
'Primary key.';

COMMENT ON COLUMN public.hubspot_provisional_contacts.email IS
'Participant email the provisional contact was created for. Stored lowercased and trimmed (enforced by CHECK); unique on lower(email).';

COMMENT ON COLUMN public.hubspot_provisional_contacts.hubspot_contact_id IS
'HubSpot contact id of the provisional contact we created.';

COMMENT ON COLUMN public.hubspot_provisional_contacts.participant_name IS
'Participant name from the transcript at the time of creation, if known.';

COMMENT ON COLUMN public.hubspot_provisional_contacts.source_interaction_id IS
'client_interactions row whose push caused this contact to be created. Set to NULL if that interaction is deleted.';

COMMENT ON COLUMN public.hubspot_provisional_contacts.source_contact_id IS
'advisor_contacts row matched to the participant, if any. Set to NULL if that contact is deleted.';

COMMENT ON COLUMN public.hubspot_provisional_contacts.status IS
'Review state. provisional = created, not yet reviewed. confirmed = reviewed and kept as the correct contact. merged = merged into another HubSpot contact (see merged_into_hubspot_contact_id). gone = no longer exists in HubSpot (deleted or otherwise removed).';

COMMENT ON COLUMN public.hubspot_provisional_contacts.merged_into_hubspot_contact_id IS
'HubSpot contact id this provisional contact was merged into. Set only when status = merged.';

COMMENT ON COLUMN public.hubspot_provisional_contacts.resolution_note IS
'Free-text note explaining how the contact was resolved (why confirmed, merged or gone).';

COMMENT ON COLUMN public.hubspot_provisional_contacts.last_error IS
'Error message from the most recent failed operation on this contact (for example a failed merge or lookup). NULL if none.';

COMMENT ON COLUMN public.hubspot_provisional_contacts.created_at IS
'When the provisional contact was created and recorded.';

COMMENT ON COLUMN public.hubspot_provisional_contacts.resolved_at IS
'When status moved off provisional (confirmed, merged or gone). NULL while provisional.';


-- =============================================================================
-- Part 3: RLS - service role only (same posture as t522 / t543)
-- =============================================================================

REVOKE ALL ON public.hubspot_provisional_contacts FROM anon, authenticated;

ALTER TABLE public.hubspot_provisional_contacts ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- Rollback
-- =============================================================================
--
--   DROP TABLE IF EXISTS public.hubspot_provisional_contacts;
--   DROP INDEX IF EXISTS public.idx_client_interactions_hubspot_unsynced;
--   ALTER TABLE public.client_interactions
--       DROP COLUMN IF EXISTS hubspot_sync_claimed_at,
--       DROP COLUMN IF EXISTS hubspot_last_error,
--       DROP COLUMN IF EXISTS hubspot_sync_attempts,
--       DROP COLUMN IF EXISTS hubspot_contact_id,
--       DROP COLUMN IF EXISTS hubspot_meeting_id,
--       DROP COLUMN IF EXISTS hubspot_synced_at;
