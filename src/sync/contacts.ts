import { LEDGER_FAILURE_PREFIX, PROVISIONAL_PROPERTY } from './constants.js';
import { HubSpotConflict, LedgerWriteError } from './errors.js';
import { normalizeEmail, splitName } from './pure.js';
import type { HubSpotApi, Logger, Row, StorePort } from './types.js';

export interface ContactResult {
  contactId: string;
  action: string;
}

function ledgerFields(interaction: Row, contactId: string): Row {
  return {
    hubspot_contact_id: contactId,
    participant_name: interaction.participant_name ?? null,
    source_interaction_id: interaction.id,
    source_contact_id: interaction.contact_id ?? null,
    status: 'provisional',
    merged_into_hubspot_contact_id: null,
    resolved_at: null,
    last_error: null,
  };
}

/** Record/refresh the provisional ledger row. A failure here must not be silent: the contact
 *  exists in HubSpot but reconcile would never see it. */
async function writeLedger(
  store: StorePort,
  ledger: Row | null,
  email: string,
  interaction: Row,
  contactId: string,
  logger: Logger,
): Promise<void> {
  try {
    if (ledger)
      await store.updateLedger(ledger.id, ledgerFields(interaction, contactId));
    else
      await store.insertLedger({
        email,
        ...ledgerFields(interaction, contactId),
      });
  } catch (err) {
    logger.warn(
      null,
      'hubspot_provisional_contacts',
      `HubSpot contact ${contactId} for ${email} exists but its ledger row could not be written ` +
        `(${(err as Error).message}); the next attempt will repair it`,
    );
    throw new LedgerWriteError(
      `${LEDGER_FAILURE_PREFIX}: HubSpot contact ${contactId} (${email}): ${(err as Error).message}`,
      contactId,
    );
  }
}

/** Existing HubSpot contact by email, else a provisional one (ledgered). */
export async function ensureContact(
  client: HubSpotApi,
  store: StorePort,
  interaction: Row,
  logger: Logger,
): Promise<ContactResult> {
  const email = normalizeEmail(interaction.participant_email)!;

  const found = await client.searchContactByEmail(email);
  if (found) {
    // Repair: a previous attempt created this contact but failed to write the ledger row.
    if (
      !(await store.getLedgerByEmail(email)) &&
      String(interaction.hubspot_last_error ?? '').startsWith(
        LEDGER_FAILURE_PREFIX,
      ) &&
      String(interaction.hubspot_contact_id) === String(found.id)
    ) {
      await writeLedger(store, null, email, interaction, found.id, logger);
    }
    return { contactId: found.id, action: 'found' };
  }

  const ledger = await store.getLedgerByEmail(email);
  if (
    ledger &&
    ['provisional', 'confirmed', 'merged'].includes(ledger.status)
  ) {
    // The email may no longer be on the HubSpot contact (a human corrected it, or it was
    // merged into the real contact), but the ledger still knows which contact is theirs.
    const target =
      ledger.status === 'merged'
        ? ledger.merged_into_hubspot_contact_id
        : ledger.hubspot_contact_id;
    if (target && (await client.getContact(target))) {
      return {
        contactId: target,
        action:
          ledger.status === 'provisional'
            ? 'reused_provisional'
            : 'reused_ledger',
      };
    }
  }

  const props: Record<string, any> = { email };
  const [first, last] = splitName(interaction.participant_name);
  if (first) props.firstname = first;
  if (last) props.lastname = last;
  if (await client.ensureProvisionalProperty()) {
    props[PROVISIONAL_PROPERTY] = 'true';
  } else {
    logger.warn(
      null,
      PROVISIONAL_PROPERTY,
      `HubSpot contact property '${PROVISIONAL_PROPERTY}' does not exist and could not be created; ` +
        `provisional contact for interaction ${interaction.id} is tracked only in hubspot_provisional_contacts`,
    );
  }

  let created;
  try {
    created = await client.createContact(props);
  } catch (err) {
    if (!(err instanceof HubSpotConflict)) throw err;
    // Contact appeared between our search and create (race): use it.
    const existing =
      (await client.searchContactByEmail(email)) ??
      (err.existingId ? { id: err.existingId } : null);
    if (!existing) throw err;
    return { contactId: existing.id, action: 'found_after_conflict' };
  }

  await writeLedger(store, ledger, email, interaction, created.id, logger);
  return { contactId: created.id, action: 'created_provisional' };
}
