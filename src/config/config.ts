export interface AppConfig {
  port: number;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  hubspotServiceKey: string;
  serviceApiKey: string;
  matchWindowMinutes: number;
  maxAttempts: number;
  /** 0 disables the retry sweeper. */
  sweepIntervalMinutes: number;
  /** Master switch: enabling writes to the production CRM and creates provisional contacts. */
  pushEnabled: boolean;
  /** Earliest created_at the sweeper may push (never an unscoped sweep). */
  pushSince?: string;
}

type Env = Record<string, string | undefined>;

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'HUBSPOT_SERVICE_KEY',
  'SERVICE_API_KEY',
] as const;

function int(env: Env, key: string, fallback: number, min: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min)
    throw new Error(`${key} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

export function loadConfig(env: Env): AppConfig {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length)
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  return {
    port: int(env, 'PORT', 3000, 1),
    supabaseUrl: env.SUPABASE_URL!,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
    hubspotServiceKey: env.HUBSPOT_SERVICE_KEY!,
    serviceApiKey: env.SERVICE_API_KEY!,
    matchWindowMinutes: int(env, 'MATCH_WINDOW_MINUTES', 30, 1),
    maxAttempts: int(env, 'HUBSPOT_MAX_ATTEMPTS', 5, 1),
    sweepIntervalMinutes: int(env, 'SWEEP_INTERVAL_MINUTES', 60, 0),
    pushEnabled: ['1', 'true'].includes(
      (env.HUBSPOT_SUMMARY_PUSH_ENABLED ?? '').trim().toLowerCase(),
    ),
    pushSince: env.HUBSPOT_PUSH_SINCE || undefined,
  };
}
