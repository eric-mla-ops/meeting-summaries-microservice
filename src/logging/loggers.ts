import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../sync/types.js';

/** Collects structured warnings and batch-inserts them to the process_log table (same table
 *  and columns as mla-notes-sync's ProcessLogger). A failed insert is reported but never
 *  thrown: logging must not break a push. */
export class ProcessLogger implements Logger {
  private entries: Array<Record<string, unknown>> = [];

  constructor(
    private readonly sb: SupabaseClient,
    private readonly processName: string,
    private readonly runId: string,
  ) {}

  warn(cusip: string | null, field: string | null, message: string): void {
    this.entries.push({
      process_name: this.processName,
      run_id: this.runId,
      level: 'warning',
      cusip,
      field_name: field,
      message,
    });
  }

  async flush(): Promise<void> {
    if (!this.entries.length) return;
    const rows = this.entries;
    this.entries = [];
    try {
      const { error } = await this.sb.from('process_log').insert(rows);
      if (error) console.error(`process_log insert failed: ${error.message}`);
    } catch (err) {
      console.error(`process_log insert failed: ${(err as Error).message}`);
    }
  }
}

/** Dry-runs: warnings print, nothing is written to process_log. */
export class ConsoleLogger implements Logger {
  warn(_cusip: string | null, field: string | null, message: string): void {
    console.log(`  [warn] ${field ?? '-'}: ${message}`);
  }
  async flush(): Promise<void> {}
}
