import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadConfig, type AppConfig } from '../config/config.js';
import { HubSpotClient } from '../hubspot/hubspot-client.js';
import { ConsoleLogger, ProcessLogger } from '../logging/loggers.js';
import { SupabaseStore } from '../store/supabase-store.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { HealthController } from './health.controller.js';
import { SummariesController } from './summaries.controller.js';
import { SweeperService } from './sweeper.service.js';
import { SyncRunner } from './sync-runner.service.js';
import { CONFIG, HUBSPOT, LOGGER_FACTORY, STORE, SUPABASE } from './tokens.js';

export const PROCESS_NAME = 'meeting_summaries_hubspot';

@Module({
  controllers: [SummariesController, HealthController],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig(process.env) },
    {
      provide: SUPABASE,
      inject: [CONFIG],
      useFactory: (cfg: AppConfig) =>
        createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
          auth: { persistSession: false },
        }),
    },
    {
      provide: STORE,
      inject: [SUPABASE],
      useFactory: (sb: SupabaseClient) => new SupabaseStore(sb),
    },
    {
      provide: HUBSPOT,
      inject: [CONFIG],
      useFactory: (cfg: AppConfig) => new HubSpotClient(cfg.hubspotServiceKey),
    },
    {
      provide: LOGGER_FACTORY,
      inject: [SUPABASE],
      useFactory: (sb: SupabaseClient) => (dryRun: boolean) =>
        dryRun
          ? new ConsoleLogger()
          : new ProcessLogger(sb, PROCESS_NAME, randomUUID()),
    },
    ApiKeyGuard,
    SyncRunner,
    SweeperService,
  ],
})
export class SummariesModule {}
