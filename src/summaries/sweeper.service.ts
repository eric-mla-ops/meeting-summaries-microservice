import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { AppConfig } from '../config/config.js';
import type { StorePort } from '../sync/types.js';
import { SyncRunner } from './sync-runner.service.js';
import { CONFIG, STORE } from './tokens.js';

/** Safety net: periodically retries unsynced rows (webhook missed or failed). Disabled when the
 *  push is off, and never unscoped: it needs HUBSPOT_PUSH_SINCE. */
@Injectable()
export class SweeperService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(STORE) private readonly store: StorePort,
    @Inject(SyncRunner) private readonly runner: SyncRunner,
  ) {}

  onModuleInit(): void {
    if (this.config.sweepIntervalMinutes <= 0 || !this.config.pushEnabled)
      return;
    this.timer = setInterval(
      () => void this.tick(),
      this.config.sweepIntervalMinutes * 60_000,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  hasTimer(): boolean {
    return this.timer !== null;
  }

  async tick(): Promise<void> {
    if (!this.config.pushEnabled || !this.config.pushSince || this.running)
      return;
    this.running = true;
    try {
      const rows = await this.store.fetchEligible({
        since: this.config.pushSince,
        maxAttempts: this.config.maxAttempts,
      });
      if (rows.length) await this.runner.run(rows, { dryRun: false });
    } catch (err) {
      console.error(`HubSpot sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
