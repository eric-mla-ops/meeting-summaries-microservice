import { describe, expect, it } from 'vitest';
import { SupabaseStore } from './supabase-store.js';

type Call = [string, any[]];

/** Recording stand-in for the supabase-js query builder: every chained call is recorded and
 *  awaiting the builder yields the next queued page for that table. */
class FakeQuery {
  calls: Call[] = [];
  constructor(
    private sb: FakeSupabase,
    private table: string,
  ) {
    return new Proxy(this, {
      get: (target, prop: string) => {
        if (prop in target || prop === 'then') return (target as any)[prop];
        return (...args: any[]) => {
          target.calls.push([prop, args]);
          return proxy;
        };
      },
    }) as FakeQuery;
  }
  // oxlint-disable-next-line unicorn/no-thenable -- deliberate: stands in for the awaitable supabase query builder
  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    this.sb.queries.push(this);
    const err = this.sb.errors[this.table];
    if (err)
      return Promise.resolve({ data: null, error: { message: err } }).then(
        resolve,
        reject,
      );
    const page = (this.sb.pages[this.table] ?? []).shift();
    return Promise.resolve({ data: page ?? [], error: null }).then(
      resolve,
      reject,
    );
  }
}
let proxy: any;

class FakeSupabase {
  queries: FakeQuery[] = [];
  errors: Record<string, string> = {};
  constructor(public pages: Record<string, any[][]> = {}) {}
  from(table: string) {
    const q = new FakeQuery(this, table);
    proxy = q;
    return q;
  }
}

const calls = (q: FakeQuery) => q.calls;
const names = (q: FakeQuery) => q.calls.map((c) => c[0]);
const has = (q: FakeQuery, name: string, ...args: any[]) =>
  q.calls.some(
    (c) =>
      c[0] === name &&
      JSON.stringify(c[1].slice(0, args.length)) === JSON.stringify(args),
  );

const store = (sb: FakeSupabase) => new SupabaseStore(sb as any);

describe('SupabaseStore', () => {
  it('fetchEligible: unsynced, email present and non-blank, since, attempt cap, stable order', async () => {
    const sb = new FakeSupabase({ client_interactions: [[{ id: 'a' }]] });
    const rows = await store(sb).fetchEligible({
      since: '2026-10-01',
      maxAttempts: 5,
    });
    expect(rows).toEqual([{ id: 'a' }]);
    const q = sb.queries[0];
    expect(has(q, 'is', 'hubspot_synced_at', null)).toBe(true);
    expect(has(q, 'not', 'participant_email', 'is', null)).toBe(true);
    expect(has(q, 'neq', 'participant_email', '')).toBe(true);
    expect(has(q, 'gte', 'created_at', '2026-10-01')).toBe(true);
    expect(has(q, 'lt', 'hubspot_sync_attempts', 5)).toBe(true);
    // created_at alone ties (up to 18 rows share a transcript): id is the tiebreaker
    expect(
      calls(q)
        .filter((c) => c[0] === 'order')
        .map((c) => c[1][0]),
    ).toEqual(['created_at', 'id']);
  });

  it('fetchEligible by interactionId has no since or attempt cap', async () => {
    const sb = new FakeSupabase({ client_interactions: [[{ id: 'a' }]] });
    await store(sb).fetchEligible({ interactionId: 'a', force: true });
    const n = names(sb.queries[0]);
    expect(n).toContain('eq');
    expect(n).not.toContain('gte');
    expect(n).not.toContain('lt');
  });

  it('fetchEligible by transcriptId filters on the transcript', async () => {
    const sb = new FakeSupabase({ client_interactions: [[]] });
    await store(sb).fetchEligible({ transcriptId: 't-1' });
    expect(has(sb.queries[0], 'eq', 'transcript_id', 't-1')).toBe(true);
  });

  it('fetchEligible: until bounds created_at; force skips the cap', async () => {
    const sb = new FakeSupabase({ client_interactions: [[]] });
    await store(sb).fetchEligible({
      since: '2026-10-01',
      until: '2026-10-05',
      force: true,
    });
    expect(has(sb.queries[0], 'lt', 'created_at', '2026-10-05')).toBe(true);
    expect(has(sb.queries[0], 'lt', 'hubspot_sync_attempts', 5)).toBe(false);
  });

  it('fetchEligible paginates past the row cap', async () => {
    const full = Array.from({ length: SupabaseStore.PAGE }, (_, i) => ({
      id: String(i),
    }));
    const sb = new FakeSupabase({
      client_interactions: [full, [{ id: 'tail' }]],
    });
    const rows = await store(sb).fetchEligible({ since: '2026-10-01' });
    expect(rows).toHaveLength(SupabaseStore.PAGE + 1);
    const ranges = sb.queries.flatMap((q) =>
      q.calls.filter((c) => c[0] === 'range').map((c) => c[1]),
    );
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('fetchEligible limit truncates', async () => {
    const sb = new FakeSupabase({
      client_interactions: [[{ id: 'a' }, { id: 'b' }, { id: 'c' }]],
    });
    expect(
      await store(sb).fetchEligible({ since: '2026-10-01', limit: 2 }),
    ).toHaveLength(2);
  });

  it('claimInteraction is a conditional update returning the row or null', async () => {
    const sb = new FakeSupabase({
      client_interactions: [[{ id: 'a', hubspot_sync_attempts: 1 }], []],
    });
    const s = store(sb);
    expect((await s.claimInteraction('a', 10))!.id).toBe('a');
    expect(await s.claimInteraction('a', 10)).toBeNull();
    const q = sb.queries[0];
    expect(names(q)[0]).toBe('update');
    expect(has(q, 'eq', 'id', 'a')).toBe(true);
    expect(has(q, 'is', 'hubspot_synced_at', null)).toBe(true);
    expect(names(q)).toContain('or');
    expect(names(q)).toContain('select');
    const orArg = q.calls.find((c) => c[0] === 'or')![1][0] as string;
    expect(orArg).toMatch(
      /^hubspot_sync_claimed_at\.is\.null,hubspot_sync_claimed_at\.lt\.\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it('getSiblingMeetingId excludes self and requires a meeting id', async () => {
    const sb = new FakeSupabase({
      client_interactions: [[{ hubspot_meeting_id: 'm-1' }], []],
    });
    const s = store(sb);
    expect(await s.getSiblingMeetingId('t-1', 'i-2')).toBe('m-1');
    expect(await s.getSiblingMeetingId('t-1', 'i-2')).toBeNull();
    const q = sb.queries[0];
    expect(has(q, 'eq', 'transcript_id', 't-1')).toBe(true);
    expect(has(q, 'neq', 'id', 'i-2')).toBe(true);
    expect(has(q, 'not', 'hubspot_meeting_id', 'is', null)).toBe(true);
  });

  it('getSiblingMeetingId without a transcript queries nothing', async () => {
    const sb = new FakeSupabase();
    expect(await store(sb).getSiblingMeetingId(null, 'i-1')).toBeNull();
    expect(sb.queries).toEqual([]);
  });

  it('email lookups escape LIKE wildcards', async () => {
    const sb = new FakeSupabase({
      client_interactions: [[]],
      advisor_contacts: [[]],
    });
    const s = store(sb);
    await s.interactionsForEmail('a_b%c@x.com');
    await s.advisorEmailExists('a_b@x.com');
    const ilikes = sb.queries.flatMap((q) =>
      q.calls.filter((c) => c[0] === 'ilike').map((c) => c[1]),
    );
    expect(ilikes).toContainEqual(['participant_email', 'a\\_b\\%c@x.com']);
    expect(ilikes).toContainEqual(['email', 'a\\_b@x.com']);
  });

  it('getLedgerByEmail, getTranscript(null), getInteractions([])', async () => {
    const sb = new FakeSupabase({
      hubspot_provisional_contacts: [[{ id: 'L1', email: 'a@b.com' }]],
    });
    const s = store(sb);
    expect((await s.getLedgerByEmail('a@b.com'))!.id).toBe('L1');
    expect(await s.getTranscript(null)).toBeNull();
    expect(await s.getInteractions([])).toEqual([]);
  });

  it('insertLedger returns the inserted row', async () => {
    const sb = new FakeSupabase({
      hubspot_provisional_contacts: [[{ id: 'L9', email: 'a@b.com' }]],
    });
    expect((await store(sb).insertLedger({ email: 'a@b.com' })).id).toBe('L9');
  });

  it('surfaces a Supabase error instead of treating it as no rows', async () => {
    const sb = new FakeSupabase();
    sb.errors.client_interactions = 'permission denied';
    await expect(
      store(sb).fetchEligible({ since: '2026-10-01' }),
    ).rejects.toThrow(/permission denied/);
  });
});
