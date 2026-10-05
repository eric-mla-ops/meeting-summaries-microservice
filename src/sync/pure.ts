import { ACTIVITY_FIELDS, type FieldType } from './activity-fields.js';
import { BLOCK_END, blockStart, DEFAULT_MAX_ATTEMPTS } from './constants.js';
import type { Row } from './types.js';

// ---------------------------------------------------------------------------
// Value formatting: a behavioural port of push_to_pipedrive.py's _format_* so
// both CRMs render the same summary (golden-tested against the Python output).
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Python truthiness: None, '', 0, False, [] and {} are all "no value". */
const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === '' ||
  v === 0 ||
  v === false ||
  (Array.isArray(v) && v.length === 0) ||
  (isPlainObject(v) && Object.keys(v).length === 0);

function formatCompetitorMentions(mentions: unknown): string | null {
  if (isEmpty(mentions) || !Array.isArray(mentions)) return null;
  const parts: string[] = [];
  for (const m of mentions) {
    if (typeof m === 'string') {
      parts.push(m);
      continue;
    }
    if (!isPlainObject(m)) continue;
    const name = m.name;
    if (isEmpty(name)) continue;
    const { sentiment, detail } = m;
    if (!isEmpty(sentiment) && !isEmpty(detail))
      parts.push(`${name} (${sentiment}): ${detail}`);
    else if (!isEmpty(sentiment)) parts.push(`${name} (${sentiment})`);
    else if (!isEmpty(detail)) parts.push(`${name}: ${detail}`);
    else parts.push(String(name));
  }
  return parts.length ? parts.join(', ') : null;
}

function formatCommunicationPrefs(prefs: unknown): string | null {
  if (isEmpty(prefs)) return null;
  if (typeof prefs === 'string') return prefs;
  if (!isPlainObject(prefs)) return null;
  const parts = [prefs.method, prefs.frequency, prefs.time].filter(
    (v) => !isEmpty(v),
  );
  return parts.length ? parts.map(String).join(', ') : null;
}

function formatValue(value: unknown, type: FieldType): string | null {
  if (isEmpty(value)) return null;
  switch (type) {
    case 'text':
      return String(value);
    case 'array':
      return Array.isArray(value) ? value.map(String).join(', ') : null;
    case 'competitor_mentions':
      return formatCompetitorMentions(value);
    case 'communication_prefs':
      return formatCommunicationPrefs(value);
    default:
      return null;
  }
}

/** Equivalent of Python's html.escape(s, quote=True). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

const str = (v: unknown): string =>
  typeof v === 'string' ? v : String(v as number);

export function normalizeEmail(email: unknown): string | null {
  if (!email || !str(email).trim()) return null;
  return str(email).trim().toLowerCase();
}

/** 'Jane Q Advisor' -> ['Jane', 'Q Advisor']. Blank -> [null, null]. Nothing invented. */
export function splitName(fullName: unknown): [string | null, string | null] {
  if (!fullName || !str(fullName).trim()) return [null, null];
  const m = str(fullName)
    .trim()
    .match(/^(\S+)(?:\s+([\s\S]+))?$/)!;
  return [m[1], m[2] ?? null];
}

// ---------------------------------------------------------------------------
// Summary block + notes merge
// ---------------------------------------------------------------------------

/** Summary text in the Pipedrive field order, wrapped in a marker block keyed on the
 *  interaction id. A meeting can carry several participants' blocks, so each names its
 *  participant. */
export function renderSummaryBlock(interaction: Row): string {
  const rows: string[] = [];
  const name = interaction.participant_name;
  const email = interaction.participant_email;
  const who = name && email ? `${name} (${email})` : name || email;
  if (who) rows.push(`<b>Participant:</b> ${escapeHtml(String(who))}<br>`);
  for (const [field, label, type] of ACTIVITY_FIELDS) {
    const formatted = formatValue(interaction[field], type);
    if (formatted) rows.push(`<b>${label}:</b> ${escapeHtml(formatted)}<br>`);
  }
  return [blockStart(interaction.id), ...rows, BLOCK_END].join('\n');
}

/** Replace this interaction's block if present, else append. Text outside our block
 *  (human notes, other participants' blocks) is preserved. */
export function mergeNotes(
  existing: string | null | undefined,
  block: string,
  interactionId: string,
): string {
  const text = existing ?? '';
  const pattern = new RegExp(
    `${escapeRegExp(blockStart(interactionId))}[\\s\\S]*?${escapeRegExp(BLOCK_END)}`,
  );
  if (pattern.test(text)) return text.replace(pattern, () => block);
  if (!text.trim()) return block;
  return text.replace(/\n+$/, '') + '\n' + block;
}

export function buildMeetingTitle(
  interaction: Row,
  transcript: Row | null | undefined,
): string | null {
  const title = transcript?.meeting_title;
  if (title) return title;
  const { participant_name: name, call_type: callType } = interaction;
  if (name && callType) return `Meeting: ${name} - ${callType}`;
  return name ? `Meeting: ${name}` : null;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const ISO_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** ISO string or epoch (10/13 digits) -> Date. Date-only values return null: a midnight
 *  guess would corrupt time-window matching. A value with no offset is taken as UTC
 *  (timestamptz values always carry one). */
export function parseDt(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  const s = str(value).trim();
  if (/^\d{10,13}$/.test(s))
    return new Date(Number(s) * (s.length === 13 ? 1 : 1000));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const m = s.match(ISO_RE);
  if (!m) return null;
  let iso = s.replace(' ', 'T');
  if (!m[1]) iso += 'Z';
  else if (m[1] !== 'Z' && !m[1].includes(':'))
    iso = iso.slice(0, -2) + ':' + iso.slice(-2);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseMeetingTime(
  interaction: Row,
  transcript: Row | null | undefined,
): Date | null {
  return (
    parseDt(transcript?.meeting_date) ?? parseDt(interaction.interaction_date)
  );
}

export const hsTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export function attemptsExhausted(
  interaction: Row,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  force = false,
): boolean {
  return !force && (interaction.hubspot_sync_attempts ?? 0) >= maxAttempts;
}

export function resolveSince(
  arg: string | undefined | null,
  env: Record<string, string | undefined>,
): string {
  const since = arg || env.HUBSPOT_PUSH_SINCE;
  if (!since) {
    throw new Error(
      'refusing an unscoped HubSpot push: pass since (YYYY-MM-DD) or set HUBSPOT_PUSH_SINCE ' +
        '(earliest created_at the sweep may push)',
    );
  }
  return since;
}
