import {
  HUBSPOT_BASE,
  MAX_HTTP_RETRIES,
  MAX_RETRY_DELAY,
  MEETING_PROPERTIES,
  MEETING_TO_CONTACT_ASSOC_TYPE_ID,
  PROVISIONAL_PROPERTY,
  PROVISIONAL_PROPERTY_SPEC,
} from '../sync/constants.js';
import { HubSpotConflict, HubSpotError } from '../sync/errors.js';
import type { Contact, HubSpotApi, Meeting } from '../sync/types.js';

export interface HubSpotClientOptions {
  fetch?: typeof fetch;
  sleep?: (seconds: number) => Promise<void>;
  maxRetries?: number;
  baseUrl?: string;
}

interface RequestOptions {
  json?: unknown;
  params?: Record<string, string | number>;
  allow404?: boolean;
}

/** Thin HubSpot CRM v3/v4 client. 429/5xx/network errors are retried a bounded number of
 *  times (honoring Retry-After, capped); other 4xx are permanent. */
export class HubSpotClient implements HubSpotApi {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (seconds: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseUrl: string;
  private readonly propertyCache = new Map<string, boolean>();

  constructor(
    private readonly token: string,
    opts: HubSpotClientOptions = {},
  ) {
    if (!token) throw new Error('HUBSPOT_SERVICE_KEY must be set');
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep =
      opts.sleep ?? ((s) => new Promise((r) => setTimeout(r, s * 1000)));
    this.maxRetries = opts.maxRetries ?? MAX_HTTP_RETRIES;
    this.baseUrl = opts.baseUrl ?? HUBSPOT_BASE;
  }

  async request(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<any> {
    let url = `${this.baseUrl}${path}`;
    if (opts.params)
      url += `?${new URLSearchParams(Object.entries(opts.params).map(([k, v]) => [k, String(v)]))}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      signal: AbortSignal.timeout(15_000),
    };

    for (let attempt = 0; ; attempt++) {
      let resp: Response;
      try {
        resp = await this.fetchFn(url, init);
      } catch (err) {
        if (attempt >= this.maxRetries)
          throw new HubSpotError(
            `network error after ${attempt} retries: ${(err as Error).message}`,
            null,
            true,
          );
        await this.sleep(Math.min(2 ** attempt, MAX_RETRY_DELAY));
        continue;
      }

      const status = resp.status;
      if (status === 429 || status >= 500) {
        if (attempt >= this.maxRetries) {
          const text = (await resp.text().catch(() => '')).slice(0, 200);
          throw new HubSpotError(
            `HTTP ${status} after ${attempt} retries: ${text}`,
            status,
            true,
          );
        }
        const header = Number(resp.headers.get('Retry-After'));
        const delay =
          resp.headers.get('Retry-After') !== null && Number.isFinite(header)
            ? Math.max(0, header)
            : null;
        await this.sleep(
          delay !== null
            ? Math.min(delay, MAX_RETRY_DELAY)
            : Math.min(2 ** attempt, MAX_RETRY_DELAY),
        );
        continue;
      }
      if (status === 404 && opts.allow404) return null;

      const text = await resp.text();
      if (status === 409) {
        const m = text.match(/Existing ID:\s*(\d+)/);
        throw new HubSpotConflict(
          `HTTP 409: ${text.slice(0, 200)}`,
          m ? m[1] : null,
        );
      }
      if (status >= 400)
        throw new HubSpotError(
          `HTTP ${status}: ${text.slice(0, 300)}`,
          status,
          false,
        );
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    }
  }

  // ---- contacts ----
  async searchContactByEmail(email: string): Promise<Contact | null> {
    const data = await this.request('POST', '/crm/v3/objects/contacts/search', {
      json: {
        filterGroups: [
          {
            filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
          },
        ],
        properties: ['email', 'firstname', 'lastname'],
        limit: 1,
      },
    });
    return data?.results?.[0] ?? null;
  }

  async getContact(id: string): Promise<Contact | null> {
    return this.request('GET', `/crm/v3/objects/contacts/${id}`, {
      params: { properties: 'email,firstname,lastname' },
      allow404: true,
    });
  }

  async contactPropertyExists(name: string): Promise<boolean> {
    if (!this.propertyCache.has(name)) {
      const found = await this.request(
        'GET',
        `/crm/v3/properties/contacts/${name}`,
        { allow404: true },
      );
      this.propertyCache.set(name, found !== null);
    }
    return this.propertyCache.get(name)!;
  }

  /** True if the marker property exists (or was just created). A creation failure (e.g. the
   *  key lacks the schema scope) returns false so the push falls back to ledger-only tracking. */
  async ensureProvisionalProperty(): Promise<boolean> {
    if (await this.contactPropertyExists(PROVISIONAL_PROPERTY)) return true;
    try {
      await this.request('POST', '/crm/v3/properties/contacts', {
        json: PROVISIONAL_PROPERTY_SPEC,
      });
    } catch (err) {
      if (err instanceof HubSpotConflict) {
        this.propertyCache.set(PROVISIONAL_PROPERTY, true);
        return true;
      }
      if (err instanceof HubSpotError) return false;
      throw err;
    }
    this.propertyCache.set(PROVISIONAL_PROPERTY, true);
    return true;
  }

  async createContact(properties: Record<string, any>): Promise<Contact> {
    return this.request('POST', '/crm/v3/objects/contacts', {
      json: { properties },
    });
  }

  async updateContact(
    id: string,
    properties: Record<string, any>,
  ): Promise<void> {
    await this.request('PATCH', `/crm/v3/objects/contacts/${id}`, {
      json: { properties },
    });
  }

  async mergeContacts(primaryId: string, mergeId: string): Promise<void> {
    await this.request('POST', '/crm/v3/objects/contacts/merge', {
      json: {
        primaryObjectId: String(primaryId),
        objectIdToMerge: String(mergeId),
      },
    });
  }

  // ---- meetings ----
  async listContactMeetings(contactId: string): Promise<Meeting[]> {
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      const params: Record<string, string | number> = { limit: 500 };
      if (after) params.after = after;
      const data =
        (await this.request(
          'GET',
          `/crm/v4/objects/contacts/${contactId}/associations/meetings`,
          { params },
        )) ?? {};
      for (const r of data.results ?? []) ids.push(String(r.toObjectId));
      after = data.paging?.next?.after;
      if (!after) break;
    }
    const meetings: Meeting[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const data =
        (await this.request('POST', '/crm/v3/objects/meetings/batch/read', {
          json: {
            properties: MEETING_PROPERTIES,
            inputs: ids.slice(i, i + 100).map((id) => ({ id })),
          },
        })) ?? {};
      meetings.push(...(data.results ?? []));
    }
    return meetings;
  }

  async findMeetingByUrl(url: string): Promise<Meeting | null> {
    const data = await this.request('POST', '/crm/v3/objects/meetings/search', {
      json: {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'hs_meeting_external_url',
                operator: 'EQ',
                value: url,
              },
            ],
          },
        ],
        properties: MEETING_PROPERTIES,
        limit: 1,
      },
    });
    return data?.results?.[0] ?? null;
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    return this.request('GET', `/crm/v3/objects/meetings/${id}`, {
      params: { properties: MEETING_PROPERTIES.join(',') },
      allow404: true,
    });
  }

  async createMeeting(
    properties: Record<string, any>,
    contactId: string,
  ): Promise<Meeting> {
    return this.request('POST', '/crm/v3/objects/meetings', {
      json: {
        properties,
        associations: [
          {
            to: { id: String(contactId) },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: MEETING_TO_CONTACT_ASSOC_TYPE_ID,
              },
            ],
          },
        ],
      },
    });
  }

  async updateMeeting(
    id: string,
    properties: Record<string, any>,
  ): Promise<void> {
    await this.request('PATCH', `/crm/v3/objects/meetings/${id}`, {
      json: { properties },
    });
  }

  /** Idempotent default association meeting -> contact. */
  async associateMeetingContact(
    meetingId: string,
    contactId: string,
  ): Promise<void> {
    await this.request(
      'PUT',
      `/crm/v4/objects/meetings/${meetingId}/associations/default/contacts/${contactId}`,
    );
  }
}
