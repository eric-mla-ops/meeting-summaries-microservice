import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CLAIM_LEASE_MINUTES,
  DEFAULT_MAX_ATTEMPTS,
} from '../sync/constants.js';
import type { FetchEligibleOptions, Row, StorePort } from '../sync/types.js';

const escapeIlike = (v: string) =>
  v.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function rows(
  builder: PromiseLike<{ data: any; error: { message: string } | null }>,
): Promise<Row[]> {
  const { data, error } = await builder;
  if (error) throw new Error(`Supabase: ${error.message}`);
  return (data ?? []) as Row[];
}

export class SupabaseStore implements StorePort {
  /** Supabase caps rows per request: every list query paginates. */
  static readonly PAGE = 1000;

  constructor(private readonly sb: SupabaseClient) {}

  private async fetchAll(build: () => any): Promise<Row[]> {
    const out: Row[] = [];
    for (let start = 0; ; start += SupabaseStore.PAGE) {
      const page = await rows(
        build().range(start, start + SupabaseStore.PAGE - 1),
      );
      out.push(...page);
      if (page.length < SupabaseStore.PAGE) return out;
    }
  }

  // ---- interactions / transcripts ----
  async getTranscript(
    transcriptId: string | null | undefined,
  ): Promise<Row | null> {
    if (!transcriptId) return null;
    const r = await rows(
      this.sb
        .from('meeting_transcripts')
        .select('id,meeting_url,meeting_title,meeting_date')
        .eq('id', transcriptId)
        .limit(1),
    );
    return r[0] ?? null;
  }

  async getInteractions(ids: string[]): Promise<Row[]> {
    if (!ids.length) return [];
    return rows(this.sb.from('client_interactions').select('*').in('id', ids));
  }

  async fetchEligible(opts: FetchEligibleOptions): Promise<Row[]> {
    const {
      interactionId,
      transcriptId,
      since,
      until,
      force = false,
      limit,
    } = opts;
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const build = () => {
      let q = this.sb
        .from('client_interactions')
        .select('*')
        .is('hubspot_synced_at', null)
        .not('participant_email', 'is', null)
        .neq('participant_email', '');
      if (interactionId) q = q.eq('id', interactionId);
      else if (transcriptId) q = q.eq('transcript_id', transcriptId);
      else {
        if (since) q = q.gte('created_at', since);
        if (until) q = q.lt('created_at', until);
      }
      if (!force && !interactionId)
        q = q.lt('hubspot_sync_attempts', maxAttempts);
      // created_at alone ties (up to 18 rows share a transcript), which makes range() pages
      // skip/repeat rows: id is the tiebreaker.
      return q
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
    };
    const all = await this.fetchAll(build);
    return limit ? all.slice(0, limit) : all;
  }

  async updateInteraction(id: string, fields: Row): Promise<void> {
    const { error } = await this.sb
      .from('client_interactions')
      .update(fields)
      .eq('id', id);
    if (error) throw new Error(`Supabase: ${error.message}`);
  }

  /** Atomic claim: succeeds only if the row is unsynced and not under a live lease.
   *  Returns the fresh row, or null when another worker holds it. */
  async claimInteraction(
    id: string,
    leaseMinutes = CLAIM_LEASE_MINUTES,
  ): Promise<Row | null> {
    const now = new Date();
    const cutoff = isoSeconds(new Date(now.getTime() - leaseMinutes * 60_000));
    const r = await rows(
      this.sb
        .from('client_interactions')
        .update({ hubspot_sync_claimed_at: isoSeconds(now) })
        .eq('id', id)
        .is('hubspot_synced_at', null)
        .or(
          `hubspot_sync_claimed_at.is.null,hubspot_sync_claimed_at.lt.${cutoff}`,
        )
        .select(),
    );
    return r[0] ?? null;
  }

  /** HubSpot meeting id already created for another participant of the same transcript. */
  async getSiblingMeetingId(
    transcriptId: string | null | undefined,
    exclude: string,
  ): Promise<string | null> {
    if (!transcriptId) return null;
    const r = await rows(
      this.sb
        .from('client_interactions')
        .select('hubspot_meeting_id')
        .eq('transcript_id', transcriptId)
        .neq('id', exclude)
        .not('hubspot_meeting_id', 'is', null)
        .limit(1),
    );
    return r[0]?.hubspot_meeting_id ?? null;
  }

  // ---- ledger ----
  async getLedgerByEmail(email: string): Promise<Row | null> {
    const r = await rows(
      this.sb
        .from('hubspot_provisional_contacts')
        .select('*')
        .eq('email', email)
        .limit(1),
    );
    return r[0] ?? null;
  }

  async insertLedger(row: Row): Promise<Row> {
    const r = await rows(
      this.sb.from('hubspot_provisional_contacts').insert(row).select(),
    );
    return r[0] ?? row;
  }

  async updateLedger(id: string, fields: Row): Promise<void> {
    const { error } = await this.sb
      .from('hubspot_provisional_contacts')
      .update(fields)
      .eq('id', id);
    if (error) throw new Error(`Supabase: ${error.message}`);
  }

  listProvisional(): Promise<Row[]> {
    return this.fetchAll(() =>
      this.sb
        .from('hubspot_provisional_contacts')
        .select('*')
        .eq('status', 'provisional')
        .order('created_at', { ascending: true }),
    );
  }

  // ---- reconcile lookups ----
  interactionsForEmail(email: string): Promise<Row[]> {
    return this.fetchAll(() =>
      this.sb
        .from('client_interactions')
        .select('*')
        .ilike('participant_email', escapeIlike(email)),
    );
  }

  async advisorEmail(contactId: string): Promise<string | null> {
    const r = await rows(
      this.sb
        .from('advisor_contacts')
        .select('email')
        .eq('contact_id', contactId)
        .limit(1),
    );
    return r[0]?.email ?? null;
  }

  async advisorEmailExists(email: string): Promise<boolean> {
    const r = await rows(
      this.sb
        .from('advisor_contacts')
        .select('contact_id')
        .ilike('email', escapeIlike(email))
        .limit(1),
    );
    return r.length > 0;
  }

  async repointInteractions(oldId: string, newId: string): Promise<void> {
    const { error } = await this.sb
      .from('client_interactions')
      .update({ hubspot_contact_id: newId })
      .eq('hubspot_contact_id', oldId);
    if (error) throw new Error(`Supabase: ${error.message}`);
  }
}
