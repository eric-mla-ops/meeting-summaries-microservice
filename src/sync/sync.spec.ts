import { describe, expect, it } from 'vitest';
import {
  FakeHubSpot,
  FakeLogger,
  FakeStore,
  makeInteraction,
  makeTranscript,
} from '../test-utils/fakes.js';
import { HubSpotConflict, HubSpotError } from './errors.js';
import { LEDGER_FAILURE_PREFIX } from './constants.js';
import { findMatchingMeeting } from './matcher.js';
import { ensureContact } from './contacts.js';
import { exitCode, runBatch, syncInteraction } from './sync.js';

const match = (
  hs: FakeHubSpot,
  contactId: string | null,
  interaction = makeInteraction(),
  transcript = makeTranscript(),
  window = 30,
  sibling: string | null = null,
) =>
  findMatchingMeeting(hs, contactId, interaction, transcript, window, sibling);

describe('findMatchingMeeting', () => {
  it('stored id wins without listing', async () => {
    const hs = new FakeHubSpot();
    const cid = hs.addContact('jane@firm.com');
    const mid = hs.addMeeting(cid, { hs_meeting_title: 'x' });
    const m = await match(
      hs,
      cid,
      makeInteraction({ hubspot_meeting_id: mid }),
    );
    expect(m.how).toBe('stored');
    expect(m.meeting!.id).toBe(mid);
    expect(hs.reads).not.toContain('listContactMeetings');
  });

  it("uses a sibling participant's meeting (same transcript)", async () => {
    const hs = new FakeHubSpot();
    const other = hs.addContact('bob@firm.com');
    const mid = hs.addMeeting(other, {});
    const cid = hs.addContact('jane@firm.com');
    const m = await match(
      hs,
      cid,
      makeInteraction(),
      makeTranscript(),
      30,
      mid,
    );
    expect(m.how).toBe('sibling');
    expect(m.meeting!.id).toBe(mid);
  });

  it('a sibling meeting that vanished falls through', async () => {
    const hs = new FakeHubSpot();
    const cid = hs.addContact('jane@firm.com');
    const m = await match(
      hs,
      cid,
      makeInteraction(),
      makeTranscript({ meeting_url: null }),
      30,
      'gone-1',
    );
    expect(m.how).toBe('none');
  });

  it('matches by url on the contact', async () => {
    const hs = new FakeHubSpot();
    const cid = hs.addContact('jane@firm.com');
    const mid = hs.addMeeting(cid, {
      hs_meeting_external_url: 'https://meet.google.com/abc-defg-hij',
    });
    hs.addMeeting(cid, {
      hs_meeting_external_url: 'https://meet.google.com/zzz',
    });
    const m = await match(hs, cid);
    expect(m.how).toBe('url');
    expect(m.meeting!.id).toBe(mid);
  });

  it('falls back to a global url search', async () => {
    const hs = new FakeHubSpot();
    const other = hs.addContact('someone@else.com');
    const mid = hs.addMeeting(other, {
      hs_meeting_external_url: 'https://meet.google.com/abc-defg-hij',
    });
    const cid = hs.addContact('jane@firm.com');
    const m = await match(hs, cid);
    expect(m.how).toBe('url_global');
    expect(m.meeting!.id).toBe(mid);
  });

  it('works without a contact (dry-run): only contact-independent steps', async () => {
    const hs = new FakeHubSpot();
    expect((await match(hs, null)).how).toBe('none');
    expect(hs.reads).not.toContain('listContactMeetings');
  });

  it('single meeting inside the window attaches', async () => {
    const hs = new FakeHubSpot();
    const cid = hs.addContact('jane@firm.com');
    const mid = hs.addMeeting(cid, {
      hs_meeting_start_time: '2026-10-05T17:20:00Z',
    });
    const m = await match(hs, cid);
    expect(m.how).toBe('window');
    expect(m.meeting!.id).toBe(mid);
  });

  it('outside the window is none', async () => {
    const hs = new FakeHubSpot();
    const cid = hs.addContact('jane@firm.com');
    hs.addMeeting(cid, { hs_meeting_start_time: '2026-10-05T19:00:00Z' });
    expect((await match(hs, cid)).how).toBe('none');
  });

  it('two in the window is ambiguous and never guessed', async () => {
    const hs = new FakeHubSpot();
    const cid = hs.addContact('jane@firm.com');
    hs.addMeeting(cid, { hs_meeting_start_time: '2026-10-05T16:50:00Z' });
    hs.addMeeting(cid, { hs_meeting_start_time: '2026-10-05T17:10:00Z' });
    const m = await match(hs, cid);
    expect(m.how).toBe('ambiguous');
    expect(m.meeting).toBeNull();
  });

  it('window is skipped when the meeting time is unknown', async () => {
    const hs = new FakeHubSpot();
    const cid = hs.addContact('jane@firm.com');
    hs.addMeeting(cid, { hs_meeting_start_time: '2026-10-05T17:00:00Z' });
    const t = makeTranscript({ meeting_date: null, meeting_url: null });
    expect(
      (
        await match(
          hs,
          cid,
          makeInteraction({ interaction_date: '2026-10-05' }),
          t,
        )
      ).how,
    ).toBe('none');
  });

  it('window is configurable', async () => {
    const hs = new FakeHubSpot();
    const cid = hs.addContact('jane@firm.com');
    hs.addMeeting(cid, { hs_meeting_start_time: '2026-10-05T18:00:00Z' });
    expect(
      (
        await match(
          hs,
          cid,
          makeInteraction(),
          makeTranscript({ meeting_url: null }),
          30,
        )
      ).how,
    ).toBe('none');
    expect(
      (
        await match(
          hs,
          cid,
          makeInteraction(),
          makeTranscript({ meeting_url: null }),
          90,
        )
      ).how,
    ).toBe('window');
  });
});

describe('ensureContact (provisional contacts)', () => {
  const setup = (hs = new FakeHubSpot()) => ({
    hs,
    store: new FakeStore(),
    log: new FakeLogger(),
  });

  it('uses an existing HubSpot contact: no ledger, no create', async () => {
    const { hs, store, log } = setup();
    const cid = hs.addContact('jane@firm.com');
    const r = await ensureContact(hs, store, makeInteraction(), log);
    expect(r).toEqual({ contactId: cid, action: 'found' });
    expect(hs.writes).toEqual([]);
    expect(store.ledger.size).toBe(0);
  });

  it('creates a provisional contact with a ledger row', async () => {
    const { hs, store, log } = setup();
    const r = await ensureContact(
      hs,
      store,
      makeInteraction({ contact_id: 'c-9' }),
      log,
    );
    expect(r.action).toBe('created_provisional');
    const [op, props] = hs.writes[0];
    expect(op).toBe('create_contact');
    expect(props).toMatchObject({
      email: 'jane@firm.com',
      firstname: 'Jane',
      lastname: 'Advisor',
      mla_provisional: 'true',
    });
    const row = (await store.getLedgerByEmail('jane@firm.com'))!;
    expect(row).toMatchObject({
      hubspot_contact_id: r.contactId,
      status: 'provisional',
      source_interaction_id: 'i-1',
      source_contact_id: 'c-9',
      participant_name: 'Jane Advisor',
    });
  });

  it('sets nothing beyond identity and the marker', async () => {
    const { hs, store, log } = setup();
    await ensureContact(hs, store, makeInteraction(), log);
    const keys = Object.keys(hs.writes[0][1]);
    expect(
      keys.every((k) =>
        ['email', 'firstname', 'lastname', 'mla_provisional'].includes(k),
      ),
    ).toBe(true);
  });

  it('missing name creates the contact with email only', async () => {
    const { hs, store, log } = setup();
    await ensureContact(
      hs,
      store,
      makeInteraction({ participant_name: null }),
      log,
    );
    expect(hs.writes[0][1]).not.toHaveProperty('firstname');
    expect(hs.writes[0][1]).not.toHaveProperty('lastname');
  });

  it('creates the marker property when missing, then sets it', async () => {
    const { hs, store, log } = setup(new FakeHubSpot(false, true));
    await ensureContact(hs, store, makeInteraction(), log);
    expect(hs.writes.some((w) => w[0] === 'create_property')).toBe(true);
    expect(hs.writesOf('create_contact')[0][1].mla_provisional).toBe('true');
  });

  it('does not recreate the marker property when it exists', async () => {
    const { hs, store, log } = setup();
    await ensureContact(hs, store, makeInteraction(), log);
    expect(hs.writesOf('create_property')).toHaveLength(0);
  });

  it('marker property that cannot be created: warns and still creates the contact', async () => {
    const { hs, store, log } = setup(new FakeHubSpot(false, false));
    const r = await ensureContact(hs, store, makeInteraction(), log);
    expect(hs.writes[0][1]).not.toHaveProperty('mla_provisional');
    expect(r.action).toBe('created_provisional');
    expect(log.messages().some((m) => m.includes('mla_provisional'))).toBe(
      true,
    );
  });

  it('a second summary for the same email reuses the provisional contact', async () => {
    const { hs, store, log } = setup();
    const a = await ensureContact(
      hs,
      store,
      makeInteraction({ id: 'i-1' }),
      log,
    );
    const b = await ensureContact(
      hs,
      store,
      makeInteraction({ id: 'i-2' }),
      log,
    );
    expect(b.contactId).toBe(a.contactId);
    expect(hs.contacts.size).toBe(1);
    expect(store.ledger.size).toBe(1);
  });

  it('reuses a provisional contact whose email a human corrected in HubSpot', async () => {
    const { hs, store, log } = setup();
    const cid = hs.addContact('corrected@firm.com');
    await store.insertLedger({
      email: 'jane@firm.com',
      hubspot_contact_id: cid,
      status: 'provisional',
    });
    const r = await ensureContact(hs, store, makeInteraction(), log);
    expect(r).toEqual({ contactId: cid, action: 'reused_provisional' });
  });

  it('a ledger row whose contact vanished is replaced, not duplicated', async () => {
    const { hs, store, log } = setup();
    const first = await ensureContact(hs, store, makeInteraction(), log);
    hs.contacts.delete(first.contactId);
    const second = await ensureContact(
      hs,
      store,
      makeInteraction({ id: 'i-2' }),
      log,
    );
    expect(second.contactId).not.toBe(first.contactId);
    expect(store.ledger.size).toBe(1);
    expect(
      (await store.getLedgerByEmail('jane@firm.com'))!.hubspot_contact_id,
    ).toBe(second.contactId);
  });

  it('a merged ledger row routes to the merge target and stays merged', async () => {
    const { hs, store, log } = setup();
    const real = hs.addContact('jane@firm.com');
    await store.insertLedger({
      email: 'jane@personal.com',
      hubspot_contact_id: '999',
      status: 'merged',
      merged_into_hubspot_contact_id: real,
    });
    const r = await ensureContact(
      hs,
      store,
      makeInteraction({ participant_email: 'jane@personal.com' }),
      log,
    );
    expect(r).toEqual({ contactId: real, action: 'reused_ledger' });
    expect(hs.writesOf('create_contact')).toHaveLength(0);
    const row = (await store.getLedgerByEmail('jane@personal.com'))!;
    expect(row.status).toBe('merged');
    expect(row.merged_into_hubspot_contact_id).toBe(real);
  });

  it('a confirmed ledger row is reused, not recreated', async () => {
    const { hs, store, log } = setup();
    const cid = hs.addContact('someone-else@x.com');
    await store.insertLedger({
      email: 'jane@personal.com',
      hubspot_contact_id: cid,
      status: 'confirmed',
    });
    const r = await ensureContact(
      hs,
      store,
      makeInteraction({ participant_email: 'jane@personal.com' }),
      log,
    );
    expect(r).toEqual({ contactId: cid, action: 'reused_ledger' });
    expect((await store.getLedgerByEmail('jane@personal.com'))!.status).toBe(
      'confirmed',
    );
  });

  it('a gone ledger row is reset to a fresh provisional contact', async () => {
    const { hs, store, log } = setup();
    await store.insertLedger({
      email: 'jane@firm.com',
      hubspot_contact_id: '404',
      status: 'gone',
    });
    const r = await ensureContact(hs, store, makeInteraction(), log);
    expect(r.action).toBe('created_provisional');
    const row = (await store.getLedgerByEmail('jane@firm.com'))!;
    expect(row.status).toBe('provisional');
    expect(row.hubspot_contact_id).toBe(r.contactId);
  });

  it('a create conflict uses the existing contact without a ledger row', async () => {
    const { hs, store, log } = setup();
    const racing = hs.addContact('jane@firm.com');
    let first = true;
    hs.searchContactByEmail = async () => {
      if (first) {
        first = false;
        return null;
      }
      return hs.contacts.get(racing)!;
    };
    hs.createContact = async () => {
      throw new HubSpotConflict('dup', racing);
    };
    const r = await ensureContact(hs, store, makeInteraction(), log);
    expect(r).toEqual({ contactId: racing, action: 'found_after_conflict' });
    expect(store.ledger.size).toBe(0);
  });
});

const env = () => {
  const hs = new FakeHubSpot();
  const store = new FakeStore();
  const log = new FakeLogger();
  store.addTranscript(makeTranscript());
  const i = store.addInteraction(makeInteraction());
  return { hs, store, log, i };
};

describe('syncInteraction', () => {
  it('happy path: new contact, creates the meeting, marks synced', async () => {
    const { hs, store, log, i } = env();
    const r = await syncInteraction(i, hs, store, log);
    expect(r).toMatchObject({
      status: 'synced',
      contactAction: 'created_provisional',
      match: 'none',
    });
    const [props, contactId] = hs.writesOf('create_meeting')[0][1];
    expect(props.hs_meeting_title).toBe('MLA / Firm intro');
    expect(props.hs_meeting_outcome).toBe('COMPLETED');
    expect(props.hs_meeting_external_url).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(props.hs_timestamp).toContain('2026-10-05T17:00:00');
    expect(props.hs_meeting_start_time).toContain('2026-10-05T17:00:00');
    expect(props.hs_internal_meeting_notes).toContain(
      '<!-- mla-summary:i-1 -->',
    );
    expect(contactId).toBe(r.contactId);
    expect(i.hubspot_synced_at).not.toBeNull();
    expect(i.hubspot_meeting_id).toBe(r.meetingId);
    expect(i.hubspot_contact_id).toBe(r.contactId);
    expect(i.hubspot_last_error).toBeNull();
    expect(i.hubspot_sync_claimed_at).toBeNull();
  });

  it('attaches to an existing meeting by url and preserves human notes', async () => {
    const { hs, store, log, i } = env();
    const cid = hs.addContact('jane@firm.com');
    const mid = hs.addMeeting(cid, {
      hs_meeting_external_url: 'https://meet.google.com/abc-defg-hij',
      hs_internal_meeting_notes: 'Drew: great prospect',
    });
    const r = await syncInteraction(i, hs, store, log);
    expect(r).toMatchObject({ status: 'synced', match: 'url', meetingId: mid });
    expect(hs.writesOf('create_meeting')).toHaveLength(0);
    const notes = hs.meetings.get(mid)!.properties.hs_internal_meeting_notes;
    expect(notes.startsWith('Drew: great prospect')).toBe(true);
    expect(notes).toContain('<!-- mla-summary:i-1 -->');
  });

  it('a re-sync with the stored meeting id replaces the block', async () => {
    const { hs, store, log, i } = env();
    await syncInteraction(i, hs, store, log);
    const mid = i.hubspot_meeting_id;
    i.hubspot_synced_at = null;
    i.summary = 'Revised summary';
    const r = await syncInteraction(i, hs, store, log, { force: true });
    expect(r.match).toBe('stored');
    const notes = hs.meetings.get(mid)!.properties.hs_internal_meeting_notes;
    expect(notes.split('<!-- mla-summary:i-1 -->').length - 1).toBe(1);
    expect(notes).toContain('Revised summary');
  });

  it('already synced is a no-op with zero HubSpot calls', async () => {
    const { hs, store, log, i } = env();
    i.hubspot_synced_at = '2026-10-05T00:00:00Z';
    expect((await syncInteraction(i, hs, store, log)).status).toBe(
      'skipped_already_synced',
    );
    expect(hs.reads).toEqual([]);
    expect(hs.writes).toEqual([]);
  });

  it('dry-run writes nothing but reports the plan', async () => {
    const { hs, store, log, i } = env();
    const r = await syncInteraction(i, hs, store, log, { dryRun: true });
    expect(r.status).toBe('dry_run');
    expect(r.contactAction).toBe('would_create_provisional');
    expect(hs.writes).toEqual([]);
    expect(store.updates).toEqual([]);
    expect(r.body).toContain('Good intro call');
    expect(i.hubspot_sync_claimed_at).toBeNull();
  });

  it('dry-run with an existing contact and meeting reports the match', async () => {
    const { hs, store, log, i } = env();
    const cid = hs.addContact('jane@firm.com');
    hs.addMeeting(cid, {
      hs_meeting_external_url: 'https://meet.google.com/abc-defg-hij',
    });
    const r = await syncInteraction(i, hs, store, log, { dryRun: true });
    expect(r).toMatchObject({ contactAction: 'found', match: 'url' });
    expect(hs.writes).toEqual([]);
    expect(store.updates).toEqual([]);
  });

  it('missing email is skipped and logged, never invented', async () => {
    const { hs, store, log, i } = env();
    i.participant_email = null;
    const r = await syncInteraction(i, hs, store, log);
    expect(r.status).toBe('skipped_no_email');
    expect(hs.reads).toEqual([]);
    expect(i.hubspot_synced_at).toBeNull();
    expect(log.calls.length).toBeGreaterThan(0);
  });

  it('a row claimed by another worker is skipped with zero HubSpot calls', async () => {
    const { hs, store, log, i } = env();
    store.denyClaims.add('i-1');
    expect((await syncInteraction(i, hs, store, log)).status).toBe(
      'skipped_claimed',
    );
    expect(hs.reads).toEqual([]);
    expect(hs.writes).toEqual([]);
  });

  it('a retryable failure records the error and attempts, keeps the contact id, releases the claim', async () => {
    const { hs, store, log, i } = env();
    hs.failOn.createMeeting = new HubSpotError('boom', 503, true);
    const r = await syncInteraction(i, hs, store, log);
    expect(r.status).toBe('failed');
    expect(i.hubspot_synced_at).toBeNull();
    expect(i.hubspot_sync_attempts).toBe(1);
    expect(i.hubspot_last_error).toContain('boom');
    expect(i.hubspot_contact_id).toBe(r.contactId);
    expect(i.hubspot_sync_claimed_at).toBeNull();
  });

  it('a retry after failure does not create a second contact', async () => {
    const { hs, store, log, i } = env();
    hs.failOn.createMeeting = new HubSpotError('boom', 503, true);
    await syncInteraction(i, hs, store, log);
    delete hs.failOn.createMeeting;
    expect((await syncInteraction(i, hs, store, log)).status).toBe('synced');
    expect(hs.contacts.size).toBe(1);
  });

  it('a crash after the meeting was created recovers by url, not a duplicate', async () => {
    const { hs, store, log, i } = env();
    const cid = hs.addContact('jane@firm.com');
    const mid = hs.addMeeting(cid, {
      hs_meeting_external_url: 'https://meet.google.com/abc-defg-hij',
    });
    expect((await syncInteraction(i, hs, store, log)).meetingId).toBe(mid);
    expect(hs.meetings.size).toBe(1);
  });

  it('no meeting time and no match is skipped (not failed), counted, never invented', async () => {
    const { hs, store, log, i } = env();
    store.transcripts.get('t-1')!.meeting_date = null;
    store.transcripts.get('t-1')!.meeting_url = null;
    i.interaction_date = '2026-10-05';
    const r = await syncInteraction(i, hs, store, log);
    expect(r.status).toBe('skipped_no_meeting_time');
    expect(hs.writesOf('create_meeting')).toHaveLength(0);
    expect(i.hubspot_last_error).toContain('meeting time');
    expect(i.hubspot_sync_attempts).toBe(1);
    expect(log.calls.length).toBeGreaterThan(0);
  });

  it('an ambiguous window creates a new meeting and warns', async () => {
    const { hs, store, log, i } = env();
    store.transcripts.get('t-1')!.meeting_url = null;
    const cid = hs.addContact('jane@firm.com');
    hs.addMeeting(cid, { hs_meeting_start_time: '2026-10-05T16:50:00Z' });
    hs.addMeeting(cid, { hs_meeting_start_time: '2026-10-05T17:10:00Z' });
    const r = await syncInteraction(i, hs, store, log);
    expect(r).toMatchObject({ status: 'synced', match: 'ambiguous' });
    expect(hs.meetings.size).toBe(3);
    expect(
      log.messages().some((m) => m.toLowerCase().includes('ambiguous')),
    ).toBe(true);
  });

  it('participants of one transcript share ONE meeting, each contact associated, each with its own block', async () => {
    const { hs, store, log } = env();
    const j2 = store.addInteraction(
      makeInteraction({
        id: 'i-2',
        participant_email: 'bob@firm.com',
        participant_name: 'Bob Advisor',
        summary: 'Bob likes SMAs',
      }),
    );
    const r1 = await syncInteraction(
      store.interactions.get('i-1')!,
      hs,
      store,
      log,
    );
    const r2 = await syncInteraction(j2, hs, store, log);
    expect(hs.contacts.size).toBe(2);
    expect(hs.meetings.size).toBe(1);
    expect(r2.match).toBe('sibling');
    expect(r2.meetingId).toBe(r1.meetingId);
    const meeting = hs.meetings.get(r1.meetingId!)!;
    expect(new Set(meeting.contact_ids)).toEqual(
      new Set([r1.contactId, r2.contactId]),
    );
    const notes = meeting.properties.hs_internal_meeting_notes;
    expect(notes).toContain('<!-- mla-summary:i-1 -->');
    expect(notes).toContain('<!-- mla-summary:i-2 -->');
    expect(notes).toContain('Bob likes SMAs');
    expect(notes).toContain('Good intro call');
    expect(hs.writes).toContainEqual([
      'associate_meeting_contact',
      [r1.meetingId, r2.contactId],
    ]);
  });

  it('different transcripts get separate meetings', async () => {
    const { hs, store, log } = env();
    store.addTranscript(
      makeTranscript({
        id: 't-2',
        meeting_url: 'https://meet.google.com/other',
        meeting_date: '2026-10-06T17:00:00+00:00',
      }),
    );
    const j2 = store.addInteraction(
      makeInteraction({
        id: 'i-2',
        transcript_id: 't-2',
        participant_email: 'bob@firm.com',
      }),
    );
    const r1 = await syncInteraction(
      store.interactions.get('i-1')!,
      hs,
      store,
      log,
    );
    const r2 = await syncInteraction(j2, hs, store, log);
    expect(hs.meetings.size).toBe(2);
    expect(r1.meetingId).not.toBe(r2.meetingId);
  });

  it('a sibling whose meeting vanished falls through to a new meeting', async () => {
    const { hs, store, log } = env();
    store.addInteraction(
      makeInteraction({
        id: 'i-0',
        hubspot_meeting_id: 'gone-123',
        hubspot_synced_at: '2026-10-05T00:00:00Z',
        participant_email: 'amy@firm.com',
      }),
    );
    store.transcripts.get('t-1')!.meeting_url = null;
    const r = await syncInteraction(
      store.interactions.get('i-1')!,
      hs,
      store,
      log,
    );
    expect(r).toMatchObject({ status: 'synced', match: 'none' });
    expect(hs.meetings.size).toBe(1);
  });

  it('a meeting found globally by url is associated to this contact', async () => {
    const { hs, store, log, i } = env();
    const other = hs.addContact('someone@else.com');
    const mid = hs.addMeeting(other, {
      hs_meeting_external_url: 'https://meet.google.com/abc-defg-hij',
    });
    const r = await syncInteraction(i, hs, store, log);
    expect(r).toMatchObject({ match: 'url_global', meetingId: mid });
    expect(hs.meetings.get(mid)!.contact_ids).toContain(r.contactId);
    expect(hs.meetings.size).toBe(1);
  });

  it('dry-run reports a sibling match without writing', async () => {
    const { hs, store, log } = env();
    const r1 = await syncInteraction(
      store.interactions.get('i-1')!,
      hs,
      store,
      log,
    );
    const j2 = store.addInteraction(
      makeInteraction({ id: 'i-2', participant_email: 'bob@firm.com' }),
    );
    const before = hs.writes.length;
    const r2 = await syncInteraction(j2, hs, store, log, { dryRun: true });
    expect(r2).toMatchObject({
      status: 'dry_run',
      contactAction: 'would_create_provisional',
      match: 'sibling',
      meetingId: r1.meetingId,
    });
    expect(hs.writes).toHaveLength(before);
  });

  it('a ledger write failure fails visibly and the retry heals the ledger', async () => {
    const { hs, store, log, i } = env();
    store.failInsertLedger = new Error('supabase down');
    const r = await syncInteraction(i, hs, store, log);
    expect(r.status).toBe('failed');
    expect(String(i.hubspot_last_error).startsWith(LEDGER_FAILURE_PREFIX)).toBe(
      true,
    );
    expect(i.hubspot_contact_id).toBe(r.contactId);
    expect(i.hubspot_synced_at).toBeNull();
    expect(log.messages().some((m) => m.includes('jane@firm.com'))).toBe(true);
    store.failInsertLedger = null;
    const r2 = await syncInteraction(i, hs, store, log);
    expect(r2.status).toBe('synced');
    expect(hs.contacts.size).toBe(1);
    const row = (await store.getLedgerByEmail('jane@firm.com'))!;
    expect(row).toMatchObject({
      hubspot_contact_id: r.contactId,
      status: 'provisional',
    });
  });
});

describe('runBatch', () => {
  it('counts results and never lets one bad row stop the batch', async () => {
    const { hs, store, log, i } = env();
    store.addTranscript(
      makeTranscript({
        id: 't-2',
        meeting_url: 'https://meet.google.com/zzz',
        meeting_date: '2026-10-06T17:00:00+00:00',
      }),
    );
    const bad = store.addInteraction(
      makeInteraction({
        id: 'i-bad',
        transcript_id: 't-2',
        participant_email: 'x@y.com',
      }),
    );
    let n = 0;
    const real = hs.createMeeting.bind(hs);
    hs.createMeeting = async (p, c) => {
      if (++n === 2) throw new Error('unexpected');
      return real(p, c);
    };
    const counts = await runBatch([i, bad], hs, store, log);
    expect(counts).toMatchObject({ synced: 1, failed: 1 });
    expect(exitCode(counts)).toBe(1);
  });

  it('a missing meeting time is skipped, not failed, and exits 0', async () => {
    const { hs, store, log, i } = env();
    store.transcripts.get('t-1')!.meeting_date = null;
    i.interaction_date = '2026-10-05';
    const counts = await runBatch([i], hs, store, log);
    expect(counts).toMatchObject({ skipped: 1, failed: 0 });
    expect(exitCode(counts)).toBe(0);
  });

  it('skips rows at the attempt cap and warns', async () => {
    const { hs, store, log, i } = env();
    i.hubspot_sync_attempts = 5;
    const counts = await runBatch([i], hs, store, log, { maxAttempts: 5 });
    expect(counts.skipped).toBe(1);
    expect(hs.reads).toEqual([]);
    expect(log.calls.length).toBeGreaterThan(0);
  });

  it('exit code is 0 on success and on nothing to do', () => {
    expect(exitCode({ synced: 2, failed: 0, skipped: 1, dry_run: 0 })).toBe(0);
    expect(exitCode({ synced: 0, failed: 0, skipped: 0, dry_run: 0 })).toBe(0);
  });
});
