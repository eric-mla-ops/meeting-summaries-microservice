import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../config/config.js';
import {
  reconcile,
  formatReport,
  reconcileExitCode,
  type Decision,
} from '../sync/reconcile.js';
import { runBatch } from '../sync/sync.js';
import type {
  BatchCounts,
  HubSpotApi,
  Logger,
  Row,
  StorePort,
  SyncResult,
} from '../sync/types.js';
import { CONFIG, HUBSPOT, LOGGER_FACTORY, STORE } from './tokens.js';

export interface RunResult {
  counts: BatchCounts;
  results: Array<{ id: string; email: string | null } & SyncResult>;
}

/**
 * Runs pushes one at a time inside this process. Participants of one transcript share a single
 * HubSpot meeting and each read-modify-writes its notes, so concurrent runs could lose a block;
 * serializing also keeps the HubSpot rate limit predictable. (The per-row claim in the database
 * additionally guards against other workers.)
 */
@Injectable()
export class SyncRunner {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(STORE) private readonly store: StorePort,
    @Inject(HUBSPOT) private readonly client: HubSpotApi,
    @Inject(LOGGER_FACTORY)
    private readonly makeLogger: (dryRun: boolean) => Logger,
  ) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Fire-and-forget background push. */
  enqueue(rows: Row[]): void {
    void this.exclusive(() => this.execute(rows, false)).catch((err) =>
      console.error(
        `background HubSpot push failed: ${(err as Error).message}`,
      ),
    );
  }

  run(rows: Row[], opts: { dryRun: boolean }): Promise<RunResult> {
    return this.exclusive(() => this.execute(rows, opts.dryRun));
  }

  async reconcile(
    apply: boolean,
  ): Promise<{ decisions: Decision[]; report: string; exitCode: number }> {
    return this.exclusive(async () => {
      const logger = this.makeLogger(!apply);
      try {
        const decisions = await reconcile(this.client, this.store, logger, {
          apply,
        });
        return {
          decisions,
          report: formatReport(decisions, apply),
          exitCode: reconcileExitCode(decisions),
        };
      } finally {
        await logger.flush();
      }
    });
  }

  /** Resolves once everything queued so far has finished (used by tests and shutdown). */
  async idle(): Promise<void> {
    await this.chain;
  }

  private async execute(rows: Row[], dryRun: boolean): Promise<RunResult> {
    const logger = this.makeLogger(dryRun);
    const results: RunResult['results'] = [];
    try {
      const counts = await runBatch(rows, this.client, this.store, logger, {
        dryRun,
        windowMinutes: this.config.matchWindowMinutes,
        maxAttempts: this.config.maxAttempts,
        onResult: (interaction, result) =>
          results.push({
            id: interaction.id,
            email: interaction.participant_email ?? null,
            ...result,
          }),
      });
      return { counts, results };
    } finally {
      await logger.flush();
    }
  }
}
