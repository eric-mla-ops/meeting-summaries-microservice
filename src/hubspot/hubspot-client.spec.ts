import { describe, expect, it } from 'vitest';
import { HubSpotClient } from './hubspot-client.js';
import { HubSpotConflict, HubSpotError } from '../sync/errors.js';
import { MAX_RETRY_DELAY } from '../sync/constants.js';

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
};

function respond(
  status: number,
  data?: any,
  headers: Record<string, string> = {},
) {
  return () =>
    new Response(data === undefined ? null : JSON.stringify(data), {
      status,
      headers,
    });
}

function makeClient(responses: Array<(() => Response) | Error>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetchFn = (async (url: string, init: any) => {
    calls.push({
      method: init.method,
      url,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift()!;
    if (next instanceof Error) throw next;
    return next();
  }) as unknown as typeof fetch;
  const client = new HubSpotClient('tok', {
    fetch: fetchFn,
    sleep: async (s) => void sleeps.push(s),
  });
  return { client, calls, sleeps };
}

describe('HubSpotClient', () => {
  it('requires a token', () => {
    expect(() => new HubSpotClient('')).toThrow(/HUBSPOT_SERVICE_KEY/);
  });

  it('sends a bearer token and a lowercased-email EQ filter, returns the first hit', async () => {
    const { client, calls } = makeClient([
      respond(200, {
        results: [{ id: '7', properties: { email: 'jane@firm.com' } }],
      }),
    ]);
    expect((await client.searchContactByEmail('jane@firm.com'))!.id).toBe('7');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].body.filterGroups[0].filters[0]).toEqual({
      propertyName: 'email',
      operator: 'EQ',
      value: 'jane@firm.com',
    });
  });

  it('search returns null when there are no results', async () => {
    const { client } = makeClient([respond(200, { results: [] })]);
    expect(await client.searchContactByEmail('a@b.com')).toBeNull();
  });

  it('429 honors Retry-After then succeeds', async () => {
    const { client, sleeps } = makeClient([
      respond(429, undefined, { 'Retry-After': '2' }),
      respond(200, { results: [] }),
    ]);
    await client.searchContactByEmail('a@b.com');
    expect(sleeps).toEqual([2]);
  });

  it('caps Retry-After', async () => {
    const { client, sleeps } = makeClient([
      respond(429, undefined, { 'Retry-After': '9999' }),
      respond(200, { results: [] }),
    ]);
    await client.searchContactByEmail('a@b.com');
    expect(sleeps).toEqual([MAX_RETRY_DELAY]);
  });

  it('5xx exhausts bounded retries then raises a retryable error', async () => {
    const { client, sleeps, calls } = makeClient([
      respond(503),
      respond(503),
      respond(503),
      respond(503),
    ]);
    const err = await client.searchContactByEmail('a@b.com').catch((e) => e);
    expect(err).toBeInstanceOf(HubSpotError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
    expect(sleeps).toHaveLength(3);
    expect(calls).toHaveLength(4);
  });

  it('network errors are retried then raise retryable', async () => {
    const boom = new TypeError('fetch failed');
    const { client, sleeps, calls } = makeClient([boom, boom, boom, boom]);
    const err = await client.searchContactByEmail('a@b.com').catch((e) => e);
    expect(err).toBeInstanceOf(HubSpotError);
    expect(err.retryable).toBe(true);
    expect(calls).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
  });

  it('other 4xx is permanent and not retried', async () => {
    const { client, sleeps } = makeClient([respond(400, { message: 'bad' })]);
    const err = await client.searchContactByEmail('a@b.com').catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(sleeps).toEqual([]);
  });

  it('getContact 404 is null', async () => {
    const { client } = makeClient([respond(404, { message: 'nf' })]);
    expect(await client.getContact('1')).toBeNull();
  });

  it('createContact 409 raises a conflict carrying the existing id', async () => {
    const { client } = makeClient([
      respond(409, { message: 'Contact already exists. Existing ID: 4455' }),
    ]);
    const err = await client
      .createContact({ email: 'a@b.com' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HubSpotConflict);
    expect(err.existingId).toBe('4455');
  });

  it('createMeeting associates to the contact with type 200', async () => {
    const { client, calls } = makeClient([
      respond(201, { id: '55', properties: {} }),
    ]);
    await client.createMeeting({ hs_timestamp: 'x' }, '9');
    expect(calls[0].body.associations[0]).toEqual({
      to: { id: '9' },
      types: [
        { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 200 },
      ],
    });
  });

  it('contactPropertyExists is true on 200, false on 404, and cached per name', async () => {
    const { client, calls } = makeClient([
      respond(200, { name: 'mla_provisional' }),
      respond(404, { message: 'nf' }),
    ]);
    expect(await client.contactPropertyExists('mla_provisional')).toBe(true);
    expect(await client.contactPropertyExists('mla_provisional')).toBe(true);
    expect(await client.contactPropertyExists('other_prop')).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('mergeContacts posts the primary and the merged id', async () => {
    const { client, calls } = makeClient([respond(200, { id: '1' })]);
    await client.mergeContacts('100', '200');
    expect(calls[0].url.endsWith('/crm/v3/objects/contacts/merge')).toBe(true);
    expect(calls[0].body).toEqual({
      primaryObjectId: '100',
      objectIdToMerge: '200',
    });
  });

  it('listContactMeetings reads associations then batch-reads', async () => {
    const { client, calls } = makeClient([
      respond(200, { results: [{ toObjectId: 11 }, { toObjectId: 12 }] }),
      respond(200, {
        results: [
          { id: '11', properties: {} },
          { id: '12', properties: {} },
        ],
      }),
    ]);
    expect((await client.listContactMeetings('9')).map((m) => m.id)).toEqual([
      '11',
      '12',
    ]);
    expect(calls[0].url).toContain(
      '/crm/v4/objects/contacts/9/associations/meetings',
    );
    expect(calls[1].url.endsWith('/crm/v3/objects/meetings/batch/read')).toBe(
      true,
    );
  });

  it('listContactMeetings follows paging and skips the batch read when empty', async () => {
    const paged = makeClient([
      respond(200, {
        results: [{ toObjectId: 1 }],
        paging: { next: { after: 'cur' } },
      }),
      respond(200, { results: [{ toObjectId: 2 }] }),
      respond(200, {
        results: [
          { id: '1', properties: {} },
          { id: '2', properties: {} },
        ],
      }),
    ]);
    expect(await paged.client.listContactMeetings('9')).toHaveLength(2);
    expect(paged.calls[1].url).toContain('after=cur');
    const empty = makeClient([respond(200, { results: [] })]);
    expect(await empty.client.listContactMeetings('9')).toEqual([]);
    expect(empty.calls).toHaveLength(1);
  });

  it('findMeetingByUrl searches hs_meeting_external_url', async () => {
    const { client, calls } = makeClient([
      respond(200, { results: [{ id: '77', properties: {} }] }),
      respond(200, { results: [] }),
    ]);
    expect(
      (await client.findMeetingByUrl('https://meet.google.com/x'))!.id,
    ).toBe('77');
    expect(
      await client.findMeetingByUrl('https://meet.google.com/y'),
    ).toBeNull();
    expect(calls[0].url.endsWith('/crm/v3/objects/meetings/search')).toBe(true);
    expect(calls[0].body.filterGroups[0].filters[0]).toEqual({
      propertyName: 'hs_meeting_external_url',
      operator: 'EQ',
      value: 'https://meet.google.com/x',
    });
  });

  it('associateMeetingContact uses the default-association PUT', async () => {
    const { client, calls } = makeClient([respond(200, {})]);
    await client.associateMeetingContact('55', '9');
    expect(calls[0].method).toBe('PUT');
    expect(
      calls[0].url.endsWith(
        '/crm/v4/objects/meetings/55/associations/default/contacts/9',
      ),
    ).toBe(true);
  });

  describe('ensureProvisionalProperty', () => {
    it('exists: no create call', async () => {
      const { client, calls } = makeClient([
        respond(200, { name: 'mla_provisional' }),
      ]);
      expect(await client.ensureProvisionalProperty()).toBe(true);
      expect(calls.map((c) => c.method)).toEqual(['GET']);
    });
    it('creates a boolean checkbox when missing, then caches', async () => {
      const { client, calls } = makeClient([
        respond(404, { message: 'nf' }),
        respond(201, { name: 'mla_provisional' }),
      ]);
      expect(await client.ensureProvisionalProperty()).toBe(true);
      const post = calls[1];
      expect(post.method).toBe('POST');
      expect(post.url.endsWith('/crm/v3/properties/contacts')).toBe(true);
      expect(post.body.name).toBe('mla_provisional');
      expect(post.body.fieldType).toBe('booleancheckbox');
      expect(post.body.type).toBe('enumeration');
      expect(post.body.options.map((o: any) => o.value).sort()).toEqual([
        'false',
        'true',
      ]);
      expect(await client.ensureProvisionalProperty()).toBe(true);
      expect(calls).toHaveLength(2);
    });
    it('409 means it already exists', async () => {
      const { client } = makeClient([
        respond(404, { message: 'nf' }),
        respond(409, { message: 'already exists' }),
      ]);
      expect(await client.ensureProvisionalProperty()).toBe(true);
    });
    it('a refusal (e.g. 403 missing scope) returns false without throwing', async () => {
      const { client } = makeClient([
        respond(404, { message: 'nf' }),
        respond(403, { message: 'missing scope' }),
      ]);
      expect(await client.ensureProvisionalProperty()).toBe(false);
    });
  });
});
