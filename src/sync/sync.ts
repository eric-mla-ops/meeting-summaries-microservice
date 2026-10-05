import {
  CLAIM_LEASE_MINUTES,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WINDOW_MINUTES,
} from './constants.js';
import { ensureContact } from './contacts.js';
import { HubSpotError } from './errors.js';
import { findMatchingMeeting } from './matcher.js';
import {
  attemptsExhausted,
  buildMeetingTitle,
  hsTime,
  mergeNotes,
  normalizeEmail,
  parseMeetingTime,
  renderSummaryBlock,
} from './pure.js';
import type {
  BatchCounts,
  HubSpotApi,
  Logger,
  Row,
  StorePort,
  SyncResult,
} from './types.js';

export interface SyncOptions {
  dryRun?: boolean;
  windowMinutes?: number;
  force?: boolean;
}

function meetingProperties(
  interaction: Row,
  transcript: Row,
  when: Date,
  body: string,
) {
  const props: Record<string, any> = {
    hs_timestamp: hsTime(when),
    hs_meeting_start_time: hsTime(when),
    hs_meeting_outcome: 'COMPLETED', // a recorded meeting has happened
    hs_internal_meeting_notes: body,
  };
  const title = buildMeetingTitle(interaction, transcript);
  if (title) props.hs_meeting_title = title;
  if (transcript?.meeting_url)
    props.hs_meeting_external_url = transcript.meeting_url;
  return props;
}

async function recordFailure(
  store: StorePort,
  interaction: Row,
  message: string,
  contactId?: string | null,
) {
  const fields: Row = {
    hubspot_sync_attempts: (interaction.hubspot_sync_attempts ?? 0) + 1,
    hubspot_last_error: message.slice(0, 500),
    hubspot_sync_claimed_at: null, // release the claim
  };
  if (contactId) fields.hubspot_contact_id = contactId;
  await store.updateInteraction(interaction.id, fields);
}

async function planContactAction(
  client: HubSpotApi,
  store: StorePort,
  email: string,
) {
  const found = await client.searchContactByEmail(email);
  if (found) return { contactId: found.id as string | null, action: 'found' };
  const ledger = await store.getLedgerByEmail(email);
  if (
    ledger?.status === 'provisional' &&
    (await client.getContact(ledger.hubspot_contact_id))
  ) {
    return {
      contactId: ledger.hubspot_contact_id as string | null,
      action: 'reused_provisional',
    };
  }
  return { contactId: null, action: 'would_create_provisional' };
}

export async function syncInteraction(
  interaction: Row,
  client: HubSpotApi,
  store: StorePort,
  logger: Logger,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const { dryRun = false, windowMinutes = DEFAULT_WINDOW_MINUTES } = opts;
  const iid = interaction.id;
  if (interaction.hubspot_synced_at)
    return { status: 'skipped_already_synced' };

  const email = normalizeEmail(interaction.participant_email);
  if (!email) {
    logger.warn(
      null,
      'participant_email',
      `interaction ${iid} has no participant_email; not pushed to HubSpot`,
    );
    return { status: 'skipped_no_email' };
  }

  const transcript =
    (await store.getTranscript(interaction.transcript_id)) ?? {};
  const body = renderSummaryBlock(interaction);
  const sibling = await store.getSiblingMeetingId(
    interaction.transcript_id,
    iid,
  );

  if (dryRun) {
    const { contactId, action } = await planContactAction(client, store, email);
    const m = await findMatchingMeeting(
      client,
      contactId,
      interaction,
      transcript,
      windowMinutes,
      sibling,
    );
    return {
      status: 'dry_run',
      contactAction: action,
      match: m.how,
      meetingId: m.meeting?.id ?? null,
      contactId,
      body,
    };
  }

  // Claim the row before any HubSpot call so the webhook, the sweeper and any other worker
  // cannot both create a meeting for it. The lease expires on its own if a worker crashes.
  const claimed = await store.claimInteraction(iid, CLAIM_LEASE_MINUTES);
  if (!claimed) return { status: 'skipped_claimed' };
  Object.assign(interaction, claimed);

  let contactId: string | null = null;
  try {
    const contact = await ensureContact(client, store, interaction, logger);
    contactId = contact.contactId;
    const m = await findMatchingMeeting(
      client,
      contactId,
      interaction,
      transcript,
      windowMinutes,
      sibling,
    );
    if (m.how === 'ambiguous') {
      logger.warn(
        null,
        'hs_meeting',
        `interaction ${iid}: ambiguous match, more than one HubSpot meeting within +-${windowMinutes} min ` +
          `for contact ${contactId}; creating a new meeting`,
      );
    }

    let meetingId: string;
    if (m.meeting) {
      meetingId = m.meeting.id;
      if (m.how === 'sibling' || m.how === 'url_global')
        await client.associateMeetingContact(meetingId, contactId);
      const notes = mergeNotes(
        m.meeting.properties?.hs_internal_meeting_notes,
        body,
        iid,
      );
      await client.updateMeeting(meetingId, {
        hs_internal_meeting_notes: notes,
      });
    } else {
      const when = parseMeetingTime(interaction, transcript);
      if (!when) {
        const msg =
          'no meeting time available (transcript.meeting_date and interaction_date carry no time); not inventing one';
        logger.warn(null, 'meeting_date', `interaction ${iid}: ${msg}`);
        await recordFailure(store, interaction, msg, contactId);
        return {
          status: 'skipped_no_meeting_time',
          contactAction: contact.action,
          match: m.how,
          contactId,
          error: msg,
        };
      }
      const created = await client.createMeeting(
        meetingProperties(interaction, transcript, when, body),
        contactId,
      );
      meetingId = created.id;
    }

    await store.updateInteraction(iid, {
      hubspot_synced_at: new Date().toISOString(),
      hubspot_meeting_id: meetingId,
      hubspot_contact_id: contactId,
      hubspot_last_error: null,
      hubspot_sync_claimed_at: null,
    });
    return {
      status: 'synced',
      contactAction: contact.action,
      match: m.how,
      meetingId,
      contactId,
    };
  } catch (err) {
    if (!(err instanceof HubSpotError)) throw err;
    contactId = (err as any).contactId ?? contactId;
    logger.warn(null, 'hubspot', `interaction ${iid}: ${err.message}`);
    await recordFailure(store, interaction, err.message, contactId);
    return { status: 'failed', contactId, error: err.message };
  }
}

export interface BatchOptions extends SyncOptions {
  maxAttempts?: number;
  onResult?: (interaction: Row, result: SyncResult) => void;
}

/** Sync each interaction; one bad row never stops the batch. */
export async function runBatch(
  interactions: Row[],
  client: HubSpotApi,
  store: StorePort,
  logger: Logger,
  opts: BatchOptions = {},
): Promise<BatchCounts> {
  const {
    dryRun = false,
    force = false,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = opts;
  const counts: BatchCounts = { synced: 0, failed: 0, skipped: 0, dry_run: 0 };
  for (const interaction of interactions) {
    if (
      attemptsExhausted(interaction, maxAttempts, force) &&
      !interaction.hubspot_synced_at
    ) {
      logger.warn(
        null,
        'hubspot_sync_attempts',
        `interaction ${interaction.id} reached ${maxAttempts} failed HubSpot attempts; skipping ` +
          `(last error: ${interaction.hubspot_last_error})`,
      );
      counts.skipped++;
      continue;
    }
    let result: SyncResult;
    try {
      result = await syncInteraction(interaction, client, store, logger, opts);
    } catch (err) {
      logger.warn(
        null,
        'hubspot',
        `interaction ${interaction.id}: unexpected ${(err as Error).message}`,
      );
      if (!dryRun) {
        try {
          await recordFailure(store, interaction, String(err));
        } catch {
          /* best effort */
        }
      }
      counts.failed++;
      continue;
    }
    const key = result.status.startsWith('skipped')
      ? 'skipped'
      : (result.status as 'synced' | 'failed' | 'dry_run');
    counts[key]++;
    opts.onResult?.(interaction, result);
  }
  return counts;
}

export const exitCode = (counts: Partial<BatchCounts> | undefined) =>
  counts?.failed ? 1 : 0;
