import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeHubSpot,
  FakeLogger,
  FakeStore,
  makeInteraction,
  makeTranscript,
} from '../test-utils/fakes.js';
import type { AppConfig } from '../config/config.js';
import { SummariesModule } from './summaries.module.js';
import { SyncRunner } from './sync-runner.service.js';
import { CONFIG, HUBSPOT, LOGGER_FACTORY, STORE, SUPABASE } from './tokens.js';

const KEY = 'secret-key';
const baseConfig: AppConfig = {
  port: 3000,
  supabaseUrl: 'https://x.supabase.co',
  supabaseServiceRoleKey: 'srk',
  hubspotServiceKey: 'hs',
  serviceApiKey: KEY,
  matchWindowMinutes: 30,
  maxAttempts: 5,
  sweepIntervalMinutes: 0,
  pushEnabled: true,
  pushSince: '2026-10-01',
};

async function boot(over: Partial<AppConfig> = {}) {
  const hs = new FakeHubSpot();
  const store = new FakeStore();
  const log = new FakeLogger();
  store.addTranscript(makeTranscript());
  const mod = await Test.createTestingModule({ imports: [SummariesModule] })
    .overrideProvider(CONFIG)
    .useValue({ ...baseConfig, ...over })
    .overrideProvider(SUPABASE)
    .useValue({})
    .overrideProvider(STORE)
    .useValue(store)
    .overrideProvider(HUBSPOT)
    .useValue(hs)
    .overrideProvider(LOGGER_FACTORY)
    .useValue(() => log)
    .compile();
  const app = mod.createNestApplication();
  await app.init();
  const runner = mod.get(SyncRunner);
  return { app, hs, store, log, runner, http: request(app.getHttpServer()) };
}

describe('HTTP API', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let app: INestApplication;
  beforeEach(async () => {
    ctx = await boot();
    app = ctx.app;
  });
  afterEach(async () => {
    await app.close();
  });
  const post = (path: string) => ctx.http.post(path).set('X-API-Key', KEY);

  describe('auth and health', () => {
    it('GET /health is unauthenticated and minimal', async () => {
      const res = await ctx.http.get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it.each(['/summaries', '/backfill', '/reconcile'])(
      'POST %s is 401 without a key',
      async (path) => {
        expect((await ctx.http.post(path).send({})).status).toBe(401);
      },
    );

    it.each(['/summaries', '/backfill', '/reconcile'])(
      'POST %s is 401 with a wrong key',
      async (path) => {
        expect(
          (await ctx.http.post(path).set('X-API-Key', 'nope').send({})).status,
        ).toBe(401);
      },
    );

    it('a key of a different length is rejected (constant-time compare must not throw)', async () => {
      expect(
        (await ctx.http.post('/summaries').set('X-API-Key', 'x').send({}))
          .status,
      ).toBe(401);
    });
  });

  describe('POST /summaries', () => {
    it.each([
      {},
      { interactionId: 'a', transcriptId: 'b' },
      { interactionId: 5 },
      { interactionId: '' },
    ])('400 on invalid body %j', async (body) => {
      expect((await post('/summaries').send(body)).status).toBe(400);
    });

    it('202 for an interactionId, then pushes in the background', async () => {
      ctx.store.addInteraction(makeInteraction());
      const res = await post('/summaries').send({ interactionId: 'i-1' });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        enabled: true,
        accepted: ['i-1'],
        skipped: [],
      });
      await ctx.runner.idle();
      expect(ctx.hs.meetings.size).toBe(1);
      expect(ctx.store.interactions.get('i-1')!.hubspot_synced_at).toBeTruthy();
    });

    it('re-posting an already synced id is skipped and writes nothing', async () => {
      ctx.store.addInteraction(makeInteraction());
      await post('/summaries').send({ interactionId: 'i-1' });
      await ctx.runner.idle();
      const writes = ctx.hs.writes.length;
      const res = await post('/summaries').send({ interactionId: 'i-1' });
      expect(res.status).toBe(202);
      expect(res.body.accepted).toEqual([]);
      expect(res.body.skipped).toEqual([
        { id: 'i-1', reason: 'already_synced' },
      ]);
      await ctx.runner.idle();
      expect(ctx.hs.writes).toHaveLength(writes);
    });

    it('unknown id is reported as not_found', async () => {
      const res = await post('/summaries').send({ interactionId: 'nope' });
      expect(res.body).toEqual({
        enabled: true,
        accepted: [],
        skipped: [{ id: 'nope', reason: 'not_found' }],
      });
    });

    it('a row without an email is reported as no_email', async () => {
      ctx.store.addInteraction(makeInteraction({ participant_email: null }));
      const res = await post('/summaries').send({ interactionId: 'i-1' });
      expect(res.body.skipped).toEqual([{ id: 'i-1', reason: 'no_email' }]);
      expect(res.body.accepted).toEqual([]);
    });

    it('a transcriptId accepts every eligible participant and they share one meeting', async () => {
      ctx.store.addInteraction(makeInteraction({ id: 'i-1' }));
      ctx.store.addInteraction(
        makeInteraction({
          id: 'i-2',
          participant_email: 'bob@firm.com',
          participant_name: 'Bob',
        }),
      );
      const res = await post('/summaries').send({ transcriptId: 't-1' });
      expect(res.status).toBe(202);
      expect(res.body.accepted.sort()).toEqual(['i-1', 'i-2']);
      await ctx.runner.idle();
      expect(ctx.hs.meetings.size).toBe(1);
      expect(ctx.hs.contacts.size).toBe(2);
    });

    it('a transcript with nothing eligible says so', async () => {
      const res = await post('/summaries').send({ transcriptId: 't-9' });
      expect(res.body.skipped).toEqual([
        { id: 't-9', reason: 'no_eligible_interactions' },
      ]);
    });

    it('a HubSpot failure in the background never breaks the response and records the error', async () => {
      ctx.store.addInteraction(makeInteraction());
      ctx.hs.failOn.searchContactByEmail = new Error('boom');
      const res = await post('/summaries').send({ interactionId: 'i-1' });
      expect(res.status).toBe(202);
      await ctx.runner.idle();
      expect(ctx.store.interactions.get('i-1')!.hubspot_synced_at).toBeNull();
      expect(ctx.store.interactions.get('i-1')!.hubspot_sync_attempts).toBe(1);
    });
  });

  describe('when the push is disabled', () => {
    beforeEach(async () => {
      await app.close();
      ctx = await boot({ pushEnabled: false });
      app = ctx.app;
    });

    it('POST /summaries acknowledges but does nothing', async () => {
      ctx.store.addInteraction(makeInteraction());
      const res = await post('/summaries').send({ interactionId: 'i-1' });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        enabled: false,
        accepted: [],
        skipped: [{ id: 'i-1', reason: 'push_disabled' }],
      });
      await ctx.runner.idle();
      expect(ctx.hs.writes).toEqual([]);
    });

    it('a real backfill is refused (409) but a dry-run still works', async () => {
      ctx.store.addInteraction(makeInteraction());
      expect(
        (await post('/backfill').send({ since: '2026-10-01', dryRun: false }))
          .status,
      ).toBe(409);
      expect(
        (await post('/backfill').send({ since: '2026-10-01' })).status,
      ).toBe(200);
      expect(ctx.hs.writes).toEqual([]);
    });

    it('reconcile apply is refused (409) but the dry-run works', async () => {
      expect((await post('/reconcile').send({ apply: true })).status).toBe(409);
      expect((await post('/reconcile').send({})).status).toBe(200);
    });
  });

  describe('POST /backfill', () => {
    it('requires since in YYYY-MM-DD form', async () => {
      expect((await post('/backfill').send({})).status).toBe(400);
      expect(
        (await post('/backfill').send({ since: 'yesterday' })).status,
      ).toBe(400);
      expect(
        (await post('/backfill').send({ since: '2026-10-01', limit: -1 }))
          .status,
      ).toBe(400);
    });

    it('defaults to a dry-run: returns the plan per row and writes nothing', async () => {
      ctx.store.addInteraction(makeInteraction());
      const res = await post('/backfill').send({ since: '2026-10-01' });
      expect(res.status).toBe(200);
      expect(res.body.dryRun).toBe(true);
      expect(res.body.counts).toMatchObject({ dry_run: 1, failed: 0 });
      expect(res.body.results[0]).toMatchObject({
        id: 'i-1',
        email: 'Jane@Firm.com',
        status: 'dry_run',
        contactAction: 'would_create_provisional',
        match: 'none',
      });
      expect(res.body.results[0].body).toContain('Good intro call');
      expect(ctx.hs.writes).toEqual([]);
      expect(ctx.store.updates).toEqual([]);
    });

    it('passes since, until and limit to the store', async () => {
      await post('/backfill').send({
        since: '2026-10-01',
        until: '2026-10-05',
        limit: 7,
      });
      expect(ctx.store.fetchOptions).toMatchObject({
        since: '2026-10-01',
        until: '2026-10-05',
        limit: 7,
      });
    });

    it('dryRun:false accepts and pushes in the background', async () => {
      ctx.store.addInteraction(makeInteraction());
      const res = await post('/backfill').send({
        since: '2026-10-01',
        dryRun: false,
      });
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ dryRun: false, accepted: 1 });
      await ctx.runner.idle();
      expect(ctx.hs.meetings.size).toBe(1);
    });
  });

  describe('POST /reconcile', () => {
    async function seed() {
      const prov = ctx.hs.addContact('jane@personal.com', {
        mla_provisional: 'true',
      });
      await ctx.store.insertLedger({
        email: 'jane@personal.com',
        hubspot_contact_id: prov,
        status: 'provisional',
      });
      ctx.store.addInteraction(
        makeInteraction({
          id: 'i-1',
          participant_email: 'jane@personal.com',
          contact_id: 'c-1',
          hubspot_contact_id: prov,
          hubspot_synced_at: 'x',
        }),
      );
      ctx.store.advisorEmails.set('c-1', 'jane@firm.com');
      const real = ctx.hs.addContact('jane@firm.com');
      return { prov, real };
    }

    it('defaults to a dry-run and reports the planned merge', async () => {
      const { real } = await seed();
      const res = await post('/reconcile').send({});
      expect(res.status).toBe(200);
      expect(res.body.apply).toBe(false);
      expect(res.body.decisions[0]).toMatchObject({
        outcome: 'merge_planned',
        targetContactId: real,
      });
      expect(res.body.report).toContain('DRY RUN');
      expect(ctx.hs.writes).toEqual([]);
    });

    it('apply:true merges', async () => {
      const { prov, real } = await seed();
      const res = await post('/reconcile').send({ apply: true });
      expect(res.body.decisions[0].outcome).toBe('merged');
      expect(ctx.hs.writes).toContainEqual(['merge_contacts', [real, prov]]);
    });

    it('rejects a non-boolean apply', async () => {
      expect((await post('/reconcile').send({ apply: 'yes' })).status).toBe(
        400,
      );
    });
  });
});
