import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/config.js';
import {
  FakeHubSpot,
  FakeLogger,
  FakeStore,
  makeInteraction,
  makeTranscript,
} from '../test-utils/fakes.js';
import { SweeperService } from './sweeper.service.js';
import { SyncRunner } from './sync-runner.service.js';

const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({
  port: 3000,
  supabaseUrl: 'u',
  supabaseServiceRoleKey: 'k',
  hubspotServiceKey: 'h',
  serviceApiKey: 's',
  matchWindowMinutes: 30,
  maxAttempts: 5,
  sweepIntervalMinutes: 60,
  pushEnabled: true,
  pushSince: '2026-10-01',
  ...over,
});

function setup(over: Partial<AppConfig> = {}) {
  const hs = new FakeHubSpot();
  const store = new FakeStore();
  const log = new FakeLogger();
  store.addTranscript(makeTranscript());
  store.addInteraction(makeInteraction());
  const config = cfg(over);
  const runner = new SyncRunner(config, store, hs, () => log);
  const sweeper = new SweeperService(config, store, runner);
  return { hs, store, log, runner, sweeper };
}

describe('SweeperService.tick', () => {
  it('pushes unsynced rows created since HUBSPOT_PUSH_SINCE', async () => {
    const { hs, store, sweeper } = setup();
    await sweeper.tick();
    expect(hs.meetings.size).toBe(1);
    expect(store.fetchOptions).toMatchObject({
      since: '2026-10-01',
      maxAttempts: 5,
    });
  });

  it('does nothing when the push is disabled', async () => {
    const { hs, store, sweeper } = setup({ pushEnabled: false });
    await sweeper.tick();
    expect(hs.reads).toEqual([]);
    expect(store.fetchOptions).toBeNull();
  });

  it('does nothing without HUBSPOT_PUSH_SINCE (never an unscoped sweep)', async () => {
    const { hs, store, sweeper } = setup({ pushSince: undefined });
    await sweeper.tick();
    expect(hs.reads).toEqual([]);
    expect(store.fetchOptions).toBeNull();
  });

  it('skips a tick while the previous one is still running', async () => {
    const { store, sweeper } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = store.fetchEligible.bind(store);
    let calls = 0;
    store.fetchEligible = async (o) => {
      calls++;
      await gate;
      return original(o);
    };
    const first = sweeper.tick();
    await sweeper.tick(); // overlapping: returns immediately
    release();
    await first;
    expect(calls).toBe(1);
  });

  it('never throws (a store failure is logged, the timer keeps running)', async () => {
    const { store, sweeper } = setup();
    store.fetchEligible = async () => {
      throw new Error('db down');
    };
    await expect(sweeper.tick()).resolves.toBeUndefined();
  });

  it('does not start a timer when the interval is 0', () => {
    const { sweeper } = setup({ sweepIntervalMinutes: 0 });
    sweeper.onModuleInit();
    expect(sweeper.hasTimer()).toBe(false);
    sweeper.onModuleDestroy();
  });

  it('starts and stops an unref-ed timer when enabled', () => {
    const { sweeper } = setup({ sweepIntervalMinutes: 5 });
    sweeper.onModuleInit();
    expect(sweeper.hasTimer()).toBe(true);
    sweeper.onModuleDestroy();
    expect(sweeper.hasTimer()).toBe(false);
  });
});

describe('SyncRunner', () => {
  it('serializes runs so sibling participants never race on the shared meeting notes', async () => {
    const { hs, store, runner } = setup();
    store.addInteraction(
      makeInteraction({
        id: 'i-2',
        participant_email: 'bob@firm.com',
        participant_name: 'Bob',
      }),
    );
    runner.enqueue([store.interactions.get('i-1')!]);
    runner.enqueue([store.interactions.get('i-2')!]);
    await runner.idle();
    expect(hs.meetings.size).toBe(1);
    const notes = [...hs.meetings.values()][0].properties
      .hs_internal_meeting_notes;
    expect(notes).toContain('mla-summary:i-1');
    expect(notes).toContain('mla-summary:i-2');
  });

  it('a failing run does not poison the queue', async () => {
    const { hs, store, runner } = setup();
    store.addInteraction(
      makeInteraction({ id: 'i-2', participant_email: 'bob@firm.com' }),
    );
    hs.failOn.searchContactByEmail = new Error('boom');
    runner.enqueue([store.interactions.get('i-1')!]);
    await runner.idle();
    delete hs.failOn.searchContactByEmail;
    runner.enqueue([store.interactions.get('i-2')!]);
    await runner.idle();
    expect(store.interactions.get('i-2')!.hubspot_synced_at).toBeTruthy();
  });
});
