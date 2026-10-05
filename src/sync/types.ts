// Row shapes mirror the Supabase tables (snake_case columns); only the fields the
// sync reads/writes are named, the rest pass through untouched.
export type Row = Record<string, any>;

export interface Contact {
  id: string;
  properties: Record<string, any>;
}

export interface Meeting {
  id: string;
  properties: Record<string, any>;
}

export interface Logger {
  warn(cusip: string | null, field: string | null, message: string): void;
  flush(): Promise<void>;
}

/** The HubSpot surface the sync needs (implemented by HubSpotClient; faked in tests). */
export interface HubSpotApi {
  searchContactByEmail(email: string): Promise<Contact | null>;
  getContact(id: string): Promise<Contact | null>;
  contactPropertyExists(name: string): Promise<boolean>;
  ensureProvisionalProperty(): Promise<boolean>;
  createContact(properties: Record<string, any>): Promise<Contact>;
  updateContact(id: string, properties: Record<string, any>): Promise<void>;
  mergeContacts(primaryId: string, mergeId: string): Promise<void>;
  listContactMeetings(contactId: string): Promise<Meeting[]>;
  findMeetingByUrl(url: string): Promise<Meeting | null>;
  getMeeting(id: string): Promise<Meeting | null>;
  createMeeting(
    properties: Record<string, any>,
    contactId: string,
  ): Promise<Meeting>;
  updateMeeting(id: string, properties: Record<string, any>): Promise<void>;
  associateMeetingContact(meetingId: string, contactId: string): Promise<void>;
}

export interface FetchEligibleOptions {
  interactionId?: string;
  transcriptId?: string;
  since?: string;
  until?: string;
  maxAttempts?: number;
  force?: boolean;
  limit?: number;
}

/** The persistence surface (implemented by SupabaseStore; faked in tests). */
export interface StorePort {
  getTranscript(transcriptId: string | null | undefined): Promise<Row | null>;
  getInteractions(ids: string[]): Promise<Row[]>;
  fetchEligible(opts: FetchEligibleOptions): Promise<Row[]>;
  updateInteraction(id: string, fields: Row): Promise<void>;
  claimInteraction(id: string, leaseMinutes?: number): Promise<Row | null>;
  getSiblingMeetingId(
    transcriptId: string | null | undefined,
    excludeInteractionId: string,
  ): Promise<string | null>;
  getLedgerByEmail(email: string): Promise<Row | null>;
  insertLedger(row: Row): Promise<Row>;
  updateLedger(id: string, fields: Row): Promise<void>;
  listProvisional(): Promise<Row[]>;
  interactionsForEmail(email: string): Promise<Row[]>;
  advisorEmail(contactId: string): Promise<string | null>;
  advisorEmailExists(email: string): Promise<boolean>;
  repointInteractions(
    oldHubspotContactId: string,
    newHubspotContactId: string,
  ): Promise<void>;
}

export type SyncStatus =
  | 'synced'
  | 'dry_run'
  | 'failed'
  | 'skipped_already_synced'
  | 'skipped_no_email'
  | 'skipped_claimed'
  | 'skipped_no_meeting_time';

export interface SyncResult {
  status: SyncStatus;
  contactAction?: string;
  match?: string;
  meetingId?: string | null;
  contactId?: string | null;
  error?: string;
  body?: string;
}

export interface MatchResult {
  how:
    | 'stored'
    | 'sibling'
    | 'url'
    | 'url_global'
    | 'window'
    | 'ambiguous'
    | 'none';
  meeting: Meeting | null;
}

export type BatchCounts = {
  synced: number;
  failed: number;
  skipped: number;
  dry_run: number;
};
