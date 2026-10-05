import { describe, expect, it } from 'vitest';
import {
  FakeHubSpot,
  FakeLogger,
  FakeStore,
  makeInteraction,
} from '../test-utils/fakes.js';
import { HubSpotError } from './errors.js';
import {
  formatReport,
  reconcile,
  reconcileExitCode,
  type Decision,
} from './reconcile.js';

async function setup() {
  const hs = new FakeHubSpot();
  const store = new FakeStore();
  const log = new FakeLogger();
  const provId = hs.addContact('jane@personal.com', {
    mla_provisional: 'true',
  });
  await store.insertLedger({
    email: 'jane@personal.com',
    hubspot_contact_id: provId,
    participant_name: 'Jane Advisor',
    source_interaction_id: 'i-1',
    source_contact_id: 'c-1',
  });
  store.addInteraction(
    makeInteraction({
      id: 'i-1',
      participant_email: 'jane@personal.com',
      contact_id: 'c-1',
      hubspot_contact_id: provId,
      hubspot_synced_at: '2026-10-05T00:00:00Z',
    }),
  );
  return { hs, store, log, provId };
}
const only = (d: Decision[]) => {
  expect(d).toHaveLength(1);
  return d[0];
};

describe('reconcile', () => {
  it('marks a contact deleted in HubSpot as gone', async () => {
    const { hs, store, log, provId } = await setup();
    hs.contacts.delete(provId);
    expect(only(await reconcile(hs, store, log, { apply: true })).outcome).toBe(
      'gone',
    );
    const row = (await store.getLedgerByEmail('jane@personal.com'))!;
    expect(row.status).toBe('gone');
    expect(row.resolved_at).not.toBeNull();
  });

  it('does not write "gone" in a dry-run', async () => {
    const { hs, store, log, provId } = await setup();
    hs.contacts.delete(provId);
    expect(
      only(await reconcile(hs, store, log, { apply: false })).outcome,
    ).toBe('gone');
    expect((await store.getLedgerByEmail('jane@personal.com'))!.status).toBe(
      'provisional',
    );
  });

  it('confirms when the email is now in advisor_contacts and clears the marker', async () => {
    const { hs, store, log, provId } = await setup();
    store.advisorEmails.set('c-1', 'jane@personal.com');
    expect(only(await reconcile(hs, store, log, { apply: true })).outcome).toBe(
      'confirmed',
    );
    expect((await store.getLedgerByEmail('jane@personal.com'))!.status).toBe(
      'confirmed',
    );
    expect(hs.contacts.get(provId)!.properties.mla_provisional).toBe('false');
    expect(hs.writesOf('merge_contacts')).toHaveLength(0);
  });

  it('skips clearing the marker when the property is missing', async () => {
    const { hs, store, log } = await setup();
    hs.provisionalProperty = false;
    store.advisorEmails.set('c-1', 'jane@personal.com');
    await reconcile(hs, store, log, { apply: true });
    expect(hs.writesOf('update_contact')).toHaveLength(0);
  });

  it('confirm requires the HubSpot contact to still carry that email', async () => {
    const { hs, store, log, provId } = await setup();
    store.advisorEmails.set('c-1', 'jane@personal.com');
    hs.contacts.get(provId)!.properties.email = 'janet@elsewhere.com';
    expect(only(await reconcile(hs, store, log, { apply: true })).outcome).toBe(
      'needs_review',
    );
    expect((await store.getLedgerByEmail('jane@personal.com'))!.status).toBe(
      'provisional',
    );
  });

  it('plans a merge from contact_id evidence in a dry-run, writing nothing', async () => {
    const { hs, store, log } = await setup();
    store.advisorEmails.set('c-1', 'jane@firm.com');
    const real = hs.addContact('jane@firm.com');
    const d = only(await reconcile(hs, store, log, { apply: false }));
    expect(d.outcome).toBe('merge_planned');
    expect(d.targetContactId).toBe(real);
    expect(d.evidence).toContain('c-1');
    expect(d.evidence).toContain('jane@firm.com');
    expect(hs.writes).toEqual([]);
    expect((await store.getLedgerByEmail('jane@personal.com'))!.status).toBe(
      'provisional',
    );
  });

  it('apply merges provisional into the real contact, updates the ledger and repoints interactions', async () => {
    const { hs, store, log, provId } = await setup();
    store.advisorEmails.set('c-1', 'jane@firm.com');
    const real = hs.addContact('jane@firm.com');
    expect(only(await reconcile(hs, store, log, { apply: true })).outcome).toBe(
      'merged',
    );
    expect(hs.writes).toContainEqual(['merge_contacts', [real, provId]]);
    const row = (await store.getLedgerByEmail('jane@personal.com'))!;
    expect(row.status).toBe('merged');
    expect(row.merged_into_hubspot_contact_id).toBe(real);
    expect(store.interactions.get('i-1')!.hubspot_contact_id).toBe(real);
  });

  it('a failed merge leaves everything provisional and records the error', async () => {
    const { hs, store, log, provId } = await setup();
    store.advisorEmails.set('c-1', 'jane@firm.com');
    hs.addContact('jane@firm.com');
    hs.mergeFails = true;
    const d = only(await reconcile(hs, store, log, { apply: true }));
    expect(d.outcome).toBe('merge_failed');
    const row = (await store.getLedgerByEmail('jane@personal.com'))!;
    expect(row.status).toBe('provisional');
    expect(row.last_error).toBeTruthy();
    expect(store.interactions.get('i-1')!.hubspot_contact_id).toBe(provId);
    expect(reconcileExitCode([d])).toBe(1);
  });

  it('no evidence is needs_review and never merged (similar names are not evidence)', async () => {
    const { hs, store, log } = await setup();
    store.interactions.get('i-1')!.contact_id = null;
    hs.addContact('jane@firm.com');
    expect(only(await reconcile(hs, store, log, { apply: true })).outcome).toBe(
      'needs_review',
    );
    expect(hs.writesOf('merge_contacts')).toHaveLength(0);
  });

  it('a candidate email with no HubSpot contact is needs_review, not created', async () => {
    const { hs, store, log } = await setup();
    store.advisorEmails.set('c-1', 'jane@firm.com');
    expect(only(await reconcile(hs, store, log, { apply: true })).outcome).toBe(
      'needs_review',
    );
    expect(hs.contacts.size).toBe(1);
    expect(hs.writesOf('create_contact')).toHaveLength(0);
  });

  it('conflicting evidence is needs_review', async () => {
    const { hs, store, log } = await setup();
    store.addInteraction(
      makeInteraction({
        id: 'i-2',
        participant_email: 'jane@personal.com',
        contact_id: 'c-2',
      }),
    );
    store.advisorEmails.set('c-1', 'jane@firm.com');
    store.advisorEmails.set('c-2', 'janet@other.com');
    hs.addContact('jane@firm.com');
    hs.addContact('janet@other.com');
    const d = only(await reconcile(hs, store, log, { apply: true }));
    expect(d.outcome).toBe('needs_review');
    expect(d.evidence.toLowerCase()).toContain('conflict');
  });

  it('only provisional rows are considered', async () => {
    const { hs, store, log } = await setup();
    (await store.getLedgerByEmail('jane@personal.com'))!.status = 'merged';
    expect(await reconcile(hs, store, log, { apply: true })).toEqual([]);
  });

  it('a HubSpot error on one row is reported and does not abort the run', async () => {
    const { hs, store, log, provId } = await setup();
    const second = hs.addContact('bob@personal.com');
    await store.insertLedger({
      email: 'bob@personal.com',
      hubspot_contact_id: second,
      status: 'provisional',
    });
    const real = hs.getContact.bind(hs);
    hs.getContact = async (id) => {
      if (String(id) === String(provId))
        throw new HubSpotError('HubSpot 503', 503, true);
      return real(id);
    };
    const decisions = await reconcile(hs, store, log, { apply: true });
    expect(decisions.map((d) => d.outcome)).toEqual(['error', 'needs_review']);
    expect(reconcileExitCode(decisions)).toBe(1);
  });

  it('a marker-clear failure does not block confirmation', async () => {
    const { hs, store, log } = await setup();
    store.advisorEmails.set('c-1', 'jane@personal.com');
    hs.updateContact = async () => {
      throw new HubSpotError('nope', 500, true);
    };
    expect(only(await reconcile(hs, store, log, { apply: true })).outcome).toBe(
      'confirmed',
    );
    expect((await store.getLedgerByEmail('jane@personal.com'))!.status).toBe(
      'confirmed',
    );
    expect(log.calls.length).toBeGreaterThan(0);
  });

  it('exit code is 0 without failures, and the report lists each decision', () => {
    expect(reconcileExitCode([])).toBe(0);
    const d: Decision = {
      ledgerId: 'L1',
      email: 'a@b.com',
      hubspotContactId: '1',
      outcome: 'merge_planned',
      targetContactId: '2',
      evidence: 'contact_id c-1 -> jane@firm.com',
    };
    expect(reconcileExitCode([{ ...d, outcome: 'needs_review' }])).toBe(0);
    const text = formatReport([d], false);
    expect(text).toContain('a@b.com');
    expect(text).toContain('merge_planned');
    expect(text).toContain('DRY RUN');
  });
});
