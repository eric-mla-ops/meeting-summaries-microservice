import { HubSpotConflict, HubSpotError } from '../sync/errors.js';
import type {
  Contact,
  FetchEligibleOptions,
  HubSpotApi,
  Logger,
  Meeting,
  Row,
  StorePort,
} from '../sync/types.js';

export class FakeLogger implements Logger {
  calls: Array<[string | null, string | null, string]> = [];
  flushed = 0;
  warn(cusip: string | null, field: string | null, message: string) {
    this.calls.push([cusip, field, message]);
  }
  async flush() {
    this.flushed++;
  }
  messages() {
    return this.calls.map((c) => c[2]);
  }
}

type Write = [string, any];

export class FakeHubSpot implements HubSpotApi {
  private n = 1000;
  contacts = new Map<string, Contact>();
  meetings = new Map<string, Meeting & { contact_ids: string[] }>();
  writes: Write[] = [];
  reads: string[] = [];
  failOn: Record<string, Error> = {};
  mergeFails = false;

  constructor(
    public provisionalProperty = true,
    public canCreateProperty = true,
  ) {}

  // ---- helpers ----
  addContact(email: string, props: Record<string, any> = {}) {
    const id = String(this.n++);
    this.contacts.set(id, {
      id,
      properties: { email: email.toLowerCase(), ...props },
    });
    return id;
  }
  addMeeting(contactId: string, props: Record<string, any> = {}) {
    const id = String(this.n++);
    this.meetings.set(id, {
      id,
      properties: { ...props },
      contact_ids: [contactId],
    });
    return id;
  }
  private maybeFail(op: string) {
    const e = this.failOn[op];
    if (e) throw e;
  }
  writesOf(op: string) {
    return this.writes.filter((w) => w[0] === op);
  }

  // ---- reads ----
  async searchContactByEmail(email: string) {
    this.reads.push('searchContactByEmail');
    this.maybeFail('searchContactByEmail');
    for (const c of this.contacts.values())
      if (c.properties.email === email) return c;
    return null;
  }
  async getContact(id: string) {
    this.reads.push('getContact');
    return this.contacts.get(String(id)) ?? null;
  }
  async contactPropertyExists(name: string) {
    this.reads.push('contactPropertyExists');
    return this.provisionalProperty && name === 'mla_provisional';
  }
  async ensureProvisionalProperty() {
    this.reads.push('ensureProvisionalProperty');
    if (this.provisionalProperty) return true;
    if (this.canCreateProperty) {
      this.provisionalProperty = true;
      this.writes.push(['create_property', 'mla_provisional']);
      return true;
    }
    return false;
  }
  async listContactMeetings(contactId: string) {
    this.reads.push('listContactMeetings');
    this.maybeFail('listContactMeetings');
    return [...this.meetings.values()].filter((m) =>
      m.contact_ids.includes(String(contactId)),
    );
  }
  async findMeetingByUrl(url: string) {
    this.reads.push('findMeetingByUrl');
    for (const m of this.meetings.values())
      if (m.properties.hs_meeting_external_url === url) return m;
    return null;
  }
  async getMeeting(id: string) {
    this.reads.push('getMeeting');
    return this.meetings.get(String(id)) ?? null;
  }

  // ---- writes ----
  async createContact(properties: Record<string, any>) {
    this.maybeFail('createContact');
    const existing = await this.searchContactByEmail(properties.email);
    if (existing) throw new HubSpotConflict('exists', existing.id);
    const { email, ...rest } = properties;
    const id = this.addContact(email, rest);
    this.writes.push(['create_contact', { ...properties }]);
    return this.contacts.get(id)!;
  }
  async updateContact(id: string, properties: Record<string, any>) {
    this.writes.push(['update_contact', [id, { ...properties }]]);
    Object.assign(this.contacts.get(String(id))!.properties, properties);
  }
  async mergeContacts(primaryId: string, mergeId: string) {
    if (this.mergeFails) throw new HubSpotError('merge refused', 400, false);
    this.writes.push(['merge_contacts', [primaryId, mergeId]]);
    this.contacts.delete(String(mergeId));
  }
  async createMeeting(properties: Record<string, any>, contactId: string) {
    this.maybeFail('createMeeting');
    const id = this.addMeeting(String(contactId), properties);
    this.writes.push([
      'create_meeting',
      [{ ...properties }, String(contactId)],
    ]);
    return this.meetings.get(id)!;
  }
  async updateMeeting(id: string, properties: Record<string, any>) {
    this.maybeFail('updateMeeting');
    this.writes.push(['update_meeting', [String(id), { ...properties }]]);
    Object.assign(this.meetings.get(String(id))!.properties, properties);
  }
  async associateMeetingContact(meetingId: string, contactId: string) {
    const m = this.meetings.get(String(meetingId))!;
    if (!m.contact_ids.includes(String(contactId)))
      m.contact_ids.push(String(contactId));
    this.writes.push([
      'associate_meeting_contact',
      [String(meetingId), String(contactId)],
    ]);
  }
}

export class FakeStore implements StorePort {
  transcripts = new Map<string, Row>();
  interactions = new Map<string, Row>();
  ledger = new Map<string, Row>();
  advisorEmails = new Map<string, string>();
  updates: Array<[string, string, Row]> = [];
  denyClaims = new Set<string>();
  failInsertLedger: Error | null = null;
  fetchOptions: FetchEligibleOptions | null = null;
  private n = 1;

  addTranscript(row: Row) {
    this.transcripts.set(row.id, row);
    return row;
  }
  addInteraction(row: Row) {
    this.interactions.set(row.id, row);
    return row;
  }
  async getTranscript(id: string | null | undefined) {
    return (id && this.transcripts.get(id)) || null;
  }
  async getInteractions(ids: string[]) {
    return ids.map((i) => this.interactions.get(i)).filter(Boolean) as Row[];
  }
  async fetchEligible(opts: FetchEligibleOptions) {
    this.fetchOptions = opts;
    return [...this.interactions.values()].filter((i) => {
      if (i.hubspot_synced_at || !i.participant_email) return false;
      if (opts.interactionId && i.id !== opts.interactionId) return false;
      if (opts.transcriptId && i.transcript_id !== opts.transcriptId)
        return false;
      if (opts.since && (i.created_at ?? '') < opts.since) return false;
      if (opts.until && (i.created_at ?? '') >= opts.until) return false;
      if (
        !opts.force &&
        !opts.interactionId &&
        (i.hubspot_sync_attempts ?? 0) >= (opts.maxAttempts ?? 5)
      )
        return false;
      return true;
    });
  }
  async updateInteraction(id: string, fields: Row) {
    this.updates.push(['client_interactions', id, { ...fields }]);
    Object.assign(this.interactions.get(id)!, fields);
  }
  async claimInteraction(id: string) {
    const row = this.interactions.get(id);
    if (!row || row.hubspot_synced_at || this.denyClaims.has(id)) return null;
    row.hubspot_sync_claimed_at = 'claimed';
    return row;
  }
  async getSiblingMeetingId(
    transcriptId: string | null | undefined,
    exclude: string,
  ) {
    for (const i of this.interactions.values())
      if (
        i.transcript_id === transcriptId &&
        i.id !== exclude &&
        i.hubspot_meeting_id
      )
        return i.hubspot_meeting_id as string;
    return null;
  }
  async getLedgerByEmail(email: string) {
    for (const r of this.ledger.values()) if (r.email === email) return r;
    return null;
  }
  async insertLedger(row: Row) {
    if (this.failInsertLedger) throw this.failInsertLedger;
    const id = `L${this.n++}`;
    const full = {
      id,
      status: 'provisional',
      merged_into_hubspot_contact_id: null,
      resolution_note: null,
      last_error: null,
      resolved_at: null,
      ...row,
    };
    this.ledger.set(id, full);
    this.updates.push(['hubspot_provisional_contacts', id, { ...row }]);
    return full;
  }
  async updateLedger(id: string, fields: Row) {
    this.updates.push(['hubspot_provisional_contacts', id, { ...fields }]);
    Object.assign(this.ledger.get(id)!, fields);
  }
  async listProvisional() {
    return [...this.ledger.values()].filter((r) => r.status === 'provisional');
  }
  async interactionsForEmail(email: string) {
    return [...this.interactions.values()].filter(
      (i) => (i.participant_email ?? '').toLowerCase() === email,
    );
  }
  async advisorEmail(contactId: string) {
    return this.advisorEmails.get(contactId) ?? null;
  }
  async advisorEmailExists(email: string) {
    return [...this.advisorEmails.values()].some(
      (e) => e?.toLowerCase() === email,
    );
  }
  async repointInteractions(oldId: string, newId: string) {
    for (const i of this.interactions.values())
      if (i.hubspot_contact_id === oldId)
        await this.updateInteraction(i.id, { hubspot_contact_id: newId });
  }
}

export function makeInteraction(over: Row = {}): Row {
  return {
    id: 'i-1',
    transcript_id: 't-1',
    contact_id: null,
    participant_name: 'Jane Advisor',
    participant_email: 'Jane@Firm.com',
    interaction_date: '2026-10-05',
    created_at: '2026-10-05T12:00:00Z',
    call_type: 'discovery',
    summary: 'Good intro call',
    pain_points: ['high fees', 'slow reporting'],
    hubspot_synced_at: null,
    hubspot_meeting_id: null,
    hubspot_contact_id: null,
    hubspot_sync_attempts: 0,
    hubspot_last_error: null,
    hubspot_sync_claimed_at: null,
    ...over,
  };
}

export function makeTranscript(over: Row = {}): Row {
  return {
    id: 't-1',
    meeting_url: 'https://meet.google.com/abc-defg-hij',
    meeting_title: 'MLA / Firm intro',
    meeting_date: '2026-10-05T17:00:00+00:00',
    ...over,
  };
}
