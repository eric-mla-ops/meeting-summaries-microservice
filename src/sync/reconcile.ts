import { PROVISIONAL_PROPERTY } from './constants.js';
import { HubSpotError } from './errors.js';
import { normalizeEmail } from './pure.js';
import type { HubSpotApi, Logger, Row, StorePort } from './types.js';

/**
 * Reconcile provisional HubSpot contacts. For each ledger row with status 'provisional':
 *   gone          the HubSpot contact no longer exists (deleted/merged by a human)
 *   confirmed     the email is now a real advisor_contacts email AND still on the HubSpot contact
 *   merge         deterministic evidence points at a different existing HubSpot contact: a source
 *                 interaction has contact_id -> advisor_contacts.email, and that email has a
 *                 HubSpot contact. The provisional contact is merged INTO it.
 *   needs_review  anything else. Never merged on name/domain similarity.
 * Merging is irreversible in HubSpot, so nothing is written without apply.
 */
export type Outcome =
  | 'gone'
  | 'confirmed'
  | 'merge_planned'
  | 'merged'
  | 'merge_failed'
  | 'needs_review'
  | 'error';

export interface Decision {
  ledgerId: string;
  email: string;
  hubspotContactId: string;
  outcome: Outcome;
  targetContactId: string | null;
  evidence: string;
}

const now = () => new Date().toISOString();

async function findMergeTarget(
  client: HubSpotApi,
  store: StorePort,
  ledger: Row,
): Promise<{ targetId: string | null; evidence: string }> {
  const email = ledger.email as string;
  const ownId = String(ledger.hubspot_contact_id);
  const targets = new Map<string, string>(); // target hubspot id -> evidence
  for (const interaction of await store.interactionsForEmail(email)) {
    const contactId = interaction.contact_id;
    if (!contactId) continue;
    const realEmail = normalizeEmail(await store.advisorEmail(contactId));
    if (!realEmail || realEmail === email) continue;
    const target = await client.searchContactByEmail(realEmail);
    if (target && String(target.id) !== ownId) {
      targets.set(
        String(target.id),
        `interaction ${interaction.id} contact_id ${contactId} -> advisor_contacts.email ${realEmail} -> HubSpot contact ${target.id}`,
      );
    }
  }
  if (targets.size === 1) {
    const [[targetId, evidence]] = [...targets];
    return { targetId, evidence };
  }
  if (targets.size > 1)
    return {
      targetId: null,
      evidence:
        'conflicting evidence: ' + [...targets.values()].sort().join('; '),
    };
  return {
    targetId: null,
    evidence:
      'no deterministic evidence (no contact_id mapping to an existing HubSpot contact)',
  };
}

async function reconcileRow(
  client: HubSpotApi,
  store: StorePort,
  logger: Logger,
  ledger: Row,
  apply: boolean,
): Promise<Decision> {
  const base = {
    ledgerId: ledger.id as string,
    email: ledger.email as string,
    hubspotContactId: String(ledger.hubspot_contact_id),
  };
  const { email } = base;
  const hsId = base.hubspotContactId;

  const contact = await client.getContact(hsId);
  if (contact === null) {
    if (apply)
      await store.updateLedger(ledger.id, {
        status: 'gone',
        resolved_at: now(),
        resolution_note: 'HubSpot contact no longer exists',
      });
    return {
      ...base,
      outcome: 'gone',
      targetContactId: null,
      evidence: 'HubSpot contact not found (deleted or merged)',
    };
  }

  if (await store.advisorEmailExists(email)) {
    const contactEmail = normalizeEmail(contact.properties?.email);
    if (contactEmail !== email) {
      const evidence = `advisor_contacts has ${email} but the HubSpot contact now carries ${contactEmail ?? 'no email'}`;
      logger.warn(
        null,
        'hubspot_provisional_contacts',
        `${email} (HubSpot ${hsId}) needs manual review: ${evidence}`,
      );
      return {
        ...base,
        outcome: 'needs_review',
        targetContactId: null,
        evidence,
      };
    }
    if (apply) {
      if (await client.contactPropertyExists(PROVISIONAL_PROPERTY)) {
        try {
          await client.updateContact(hsId, { [PROVISIONAL_PROPERTY]: 'false' });
        } catch (err) {
          if (!(err instanceof HubSpotError)) throw err;
          logger.warn(
            null,
            PROVISIONAL_PROPERTY,
            `could not clear ${PROVISIONAL_PROPERTY} on HubSpot ${hsId}: ${err.message}`,
          );
        }
      }
      await store.updateLedger(ledger.id, {
        status: 'confirmed',
        resolved_at: now(),
        resolution_note: 'email present in advisor_contacts',
      });
    }
    return {
      ...base,
      outcome: 'confirmed',
      targetContactId: null,
      evidence: 'email exists in advisor_contacts and on the HubSpot contact',
    };
  }

  const { targetId, evidence } = await findMergeTarget(client, store, ledger);
  if (targetId === null) {
    logger.warn(
      null,
      'hubspot_provisional_contacts',
      `${email} (HubSpot ${hsId}) needs manual review: ${evidence}`,
    );
    return {
      ...base,
      outcome: 'needs_review',
      targetContactId: null,
      evidence,
    };
  }
  if (!apply)
    return {
      ...base,
      outcome: 'merge_planned',
      targetContactId: targetId,
      evidence,
    };

  try {
    await client.mergeContacts(targetId, hsId); // primary = the real contact
  } catch (err) {
    if (!(err instanceof HubSpotError)) throw err;
    await store.updateLedger(ledger.id, {
      last_error: err.message.slice(0, 500),
    });
    logger.warn(
      null,
      'hubspot_provisional_contacts',
      `merge of ${email} (HubSpot ${hsId}) into ${targetId} failed: ${err.message}`,
    );
    return {
      ...base,
      outcome: 'merge_failed',
      targetContactId: targetId,
      evidence: `${evidence}; error: ${err.message}`,
    };
  }
  await store.updateLedger(ledger.id, {
    status: 'merged',
    merged_into_hubspot_contact_id: targetId,
    resolved_at: now(),
    resolution_note: evidence,
    last_error: null,
  });
  await store.repointInteractions(hsId, targetId);
  return { ...base, outcome: 'merged', targetContactId: targetId, evidence };
}

export async function reconcile(
  client: HubSpotApi,
  store: StorePort,
  logger: Logger,
  opts: { apply?: boolean } = {},
): Promise<Decision[]> {
  const apply = opts.apply ?? false;
  const decisions: Decision[] = [];
  for (const ledger of await store.listProvisional()) {
    try {
      decisions.push(await reconcileRow(client, store, logger, ledger, apply));
    } catch (err) {
      if (!(err instanceof HubSpotError)) throw err; // one bad HubSpot row never aborts the run
      logger.warn(
        null,
        'hubspot_provisional_contacts',
        `${ledger.email} (HubSpot ${ledger.hubspot_contact_id}): ${err.message}`,
      );
      decisions.push({
        ledgerId: ledger.id,
        email: ledger.email,
        hubspotContactId: String(ledger.hubspot_contact_id),
        outcome: 'error',
        targetContactId: null,
        evidence: err.message,
      });
    }
  }
  return decisions;
}

export const reconcileExitCode = (decisions: Decision[]) =>
  decisions.some((d) => d.outcome === 'merge_failed' || d.outcome === 'error')
    ? 1
    : 0;

export function formatReport(decisions: Decision[], apply: boolean): string {
  const lines = [
    `Provisional contact reconcile (${apply ? 'APPLY' : 'DRY RUN'}): ${decisions.length} row(s)`,
  ];
  for (const d of decisions) {
    const target = d.targetContactId ? ` -> ${d.targetContactId}` : '';
    lines.push(
      `  [${d.outcome}] ${d.email} (HubSpot ${d.hubspotContactId})${target}: ${d.evidence}`,
    );
  }
  return lines.join('\n');
}
