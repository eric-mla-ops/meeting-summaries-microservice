import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const required = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'srk',
  HUBSPOT_SERVICE_KEY: 'hs',
  SERVICE_API_KEY: 'secret',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(required);
    expect(c).toMatchObject({
      port: 3000,
      matchWindowMinutes: 30,
      maxAttempts: 5,
      sweepIntervalMinutes: 60,
      pushEnabled: false,
      pushSince: undefined,
      supabaseUrl: 'https://x.supabase.co',
      serviceApiKey: 'secret',
    });
  });

  it.each([
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'HUBSPOT_SERVICE_KEY',
    'SERVICE_API_KEY',
  ])('fails fast when %s is missing', (key) => {
    const env: Record<string, string> = { ...required };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(new RegExp(key));
  });

  it('lists every missing variable at once', () => {
    expect(() => loadConfig({})).toThrow(
      /SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY.*HUBSPOT_SERVICE_KEY.*SERVICE_API_KEY/s,
    );
  });

  it('parses overrides and the enable flag', () => {
    const c = loadConfig({
      ...required,
      PORT: '4000',
      MATCH_WINDOW_MINUTES: '45',
      HUBSPOT_MAX_ATTEMPTS: '3',
      SWEEP_INTERVAL_MINUTES: '0',
      HUBSPOT_PUSH_SINCE: '2026-10-01',
      HUBSPOT_SUMMARY_PUSH_ENABLED: 'TRUE',
    });
    expect(c).toMatchObject({
      port: 4000,
      matchWindowMinutes: 45,
      maxAttempts: 3,
      sweepIntervalMinutes: 0,
      pushSince: '2026-10-01',
      pushEnabled: true,
    });
  });

  it.each(['1', 'true', 'True'])('treats %s as enabled', (v) => {
    expect(
      loadConfig({ ...required, HUBSPOT_SUMMARY_PUSH_ENABLED: v }).pushEnabled,
    ).toBe(true);
  });

  it.each(['', 'false', '0', 'yes', 'no'])('treats %j as disabled', (v) => {
    expect(
      loadConfig({ ...required, HUBSPOT_SUMMARY_PUSH_ENABLED: v }).pushEnabled,
    ).toBe(false);
  });

  it('rejects non-numeric numbers', () => {
    expect(() => loadConfig({ ...required, PORT: 'abc' })).toThrow(/PORT/);
    expect(() =>
      loadConfig({ ...required, MATCH_WINDOW_MINUTES: '-5' }),
    ).toThrow(/MATCH_WINDOW_MINUTES/);
  });
});
