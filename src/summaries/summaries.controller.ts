import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AppConfig } from '../config/config.js';
import { normalizeEmail } from '../sync/pure.js';
import type { StorePort } from '../sync/types.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { SyncRunner } from './sync-runner.service.js';
import { CONFIG, STORE } from './tokens.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DRY_RUN_DEFAULT_LIMIT = 100;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '';

@Controller()
@UseGuards(ApiKeyGuard)
export class SummariesController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(STORE) private readonly store: StorePort,
    @Inject(SyncRunner) private readonly runner: SyncRunner,
  ) {}

  /** Called by MLA Notes Sync (or anything else) when a summary is ready. The service reads the
   *  rows itself (Supabase is the source of truth), answers immediately, and pushes in the
   *  background. Re-posting a synced id is a harmless no-op. */
  @Post('summaries')
  @HttpCode(202)
  async summaries(@Body() body: Record<string, unknown> | undefined) {
    const { interactionId, transcriptId } = body ?? {};
    const hasI = interactionId !== undefined;
    const hasT = transcriptId !== undefined;
    if (hasI === hasT)
      throw new BadRequestException(
        'send exactly one of interactionId or transcriptId',
      );
    const target = hasI ? interactionId : transcriptId;
    if (!isNonEmptyString(target))
      throw new BadRequestException(
        'interactionId/transcriptId must be a non-empty string',
      );

    if (!this.config.pushEnabled) {
      return {
        enabled: false,
        accepted: [],
        skipped: [{ id: target, reason: 'push_disabled' }],
      };
    }

    const skipped: Array<{ id: string; reason: string }> = [];
    let eligible;
    if (hasI) {
      const [row] = await this.store.getInteractions([target]);
      if (!row) skipped.push({ id: target, reason: 'not_found' });
      else if (row.hubspot_synced_at)
        skipped.push({ id: target, reason: 'already_synced' });
      else if (!normalizeEmail(row.participant_email))
        skipped.push({ id: target, reason: 'no_email' });
      eligible = row && !skipped.length ? [row] : [];
    } else {
      eligible = await this.store.fetchEligible({
        transcriptId: target,
        force: true,
      });
      if (!eligible.length)
        skipped.push({ id: target, reason: 'no_eligible_interactions' });
    }

    if (eligible.length) this.runner.enqueue(eligible);
    return { enabled: true, accepted: eligible.map((r) => r.id), skipped };
  }

  /** Manual backfill. Defaults to a dry-run that returns the plan per row and writes nothing. */
  @Post('backfill')
  async backfill(
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { since, until, limit, dryRun = true } = body ?? {};
    if (typeof since !== 'string' || !DATE_RE.test(since))
      throw new BadRequestException('since (YYYY-MM-DD) is required');
    if (
      until !== undefined &&
      (typeof until !== 'string' || !DATE_RE.test(until))
    )
      throw new BadRequestException('until must be YYYY-MM-DD');
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || (limit as number) < 1)
    )
      throw new BadRequestException('limit must be a positive integer');
    if (typeof dryRun !== 'boolean')
      throw new BadRequestException('dryRun must be a boolean');
    if (!dryRun && !this.config.pushEnabled)
      throw new ConflictException(
        'HubSpot push is disabled (HUBSPOT_SUMMARY_PUSH_ENABLED)',
      );

    const rows = await this.store.fetchEligible({
      since,
      until: until as string | undefined,
      limit:
        (limit as number | undefined) ??
        (dryRun ? DRY_RUN_DEFAULT_LIMIT : undefined),
      maxAttempts: this.config.maxAttempts,
    });
    if (dryRun) {
      const { counts, results } = await this.runner.run(rows, { dryRun: true });
      res.status(200);
      return { dryRun: true, counts, results };
    }
    this.runner.enqueue(rows);
    res.status(202);
    return { dryRun: false, accepted: rows.length };
  }

  /** Review provisional contacts. Dry-run unless apply:true (merging is irreversible in HubSpot). */
  @Post('reconcile')
  @HttpCode(200)
  async reconcile(@Body() body: Record<string, unknown> | undefined) {
    const { apply = false } = body ?? {};
    if (typeof apply !== 'boolean')
      throw new BadRequestException('apply must be a boolean');
    if (apply && !this.config.pushEnabled)
      throw new ConflictException(
        'HubSpot push is disabled (HUBSPOT_SUMMARY_PUSH_ENABLED)',
      );
    const { decisions, report, exitCode } = await this.runner.reconcile(apply);
    return { apply, decisions, report, exitCode };
  }
}
