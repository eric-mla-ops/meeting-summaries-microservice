import { describe, expect, it, vi } from 'vitest';
import { ConsoleLogger, ProcessLogger } from './loggers.js';

function fakeSb(error: string | null = null) {
  const inserts: any[] = [];
  return {
    inserts,
    from: (table: string) => ({
      insert: async (rows: any[]) => {
        inserts.push([table, rows]);
        return { error: error ? { message: error } : null };
      },
    }),
  } as any;
}

describe('ProcessLogger', () => {
  it('collects warnings and batch-inserts them to process_log, then clears', async () => {
    const sb = fakeSb();
    const log = new ProcessLogger(sb, 'meeting_summaries_hubspot', 'run-1');
    log.warn(null, 'participant_email', 'no email');
    log.warn('CUSIP1', 'x', 'y');
    await log.flush();
    expect(sb.inserts).toHaveLength(1);
    const [table, rows] = sb.inserts[0];
    expect(table).toBe('process_log');
    expect(rows).toEqual([
      {
        process_name: 'meeting_summaries_hubspot',
        run_id: 'run-1',
        level: 'warning',
        cusip: null,
        field_name: 'participant_email',
        message: 'no email',
      },
      {
        process_name: 'meeting_summaries_hubspot',
        run_id: 'run-1',
        level: 'warning',
        cusip: 'CUSIP1',
        field_name: 'x',
        message: 'y',
      },
    ]);
    await log.flush();
    expect(sb.inserts).toHaveLength(1);
  });

  it('flush does nothing when there are no warnings', async () => {
    const sb = fakeSb();
    await new ProcessLogger(sb, 'p', 'r').flush();
    expect(sb.inserts).toEqual([]);
  });

  it('a failing insert is reported but never throws (logging must not break a push)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = new ProcessLogger(fakeSb('db down'), 'p', 'r');
    log.warn(null, 'f', 'm');
    await expect(log.flush()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('ConsoleLogger', () => {
  it('prints warnings and writes nothing anywhere', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = new ConsoleLogger();
    log.warn(null, 'field', 'something odd');
    await log.flush();
    expect(out.mock.calls.flat().join(' ')).toContain('something odd');
    out.mockRestore();
  });
});
