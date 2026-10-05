import { DEFAULT_WINDOW_MINUTES } from './constants.js';
import { parseDt, parseMeetingTime } from './pure.js';
import type { HubSpotApi, MatchResult, Row } from './types.js';

/**
 * stored id -> a sibling participant's meeting (same transcript) -> meeting URL (on the
 * contact, then anywhere in HubSpot) -> single meeting in +-window -> none.
 * Participants of one transcript share one meeting. Two or more candidates in the window
 * are ambiguous: never guess. `contactId` may be null (dry-run, contact not created yet):
 * only the contact-independent steps run.
 */
export async function findMatchingMeeting(
  client: HubSpotApi,
  contactId: string | null,
  interaction: Row,
  transcript: Row | null | undefined,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
  siblingMeetingId: string | null = null,
): Promise<MatchResult> {
  const stored = interaction.hubspot_meeting_id;
  if (stored) {
    const meeting = await client.getMeeting(stored);
    if (meeting) return { how: 'stored', meeting };
  }

  if (siblingMeetingId) {
    const meeting = await client.getMeeting(siblingMeetingId);
    if (meeting) return { how: 'sibling', meeting };
  }

  const meetings = contactId ? await client.listContactMeetings(contactId) : [];

  const url = transcript?.meeting_url;
  if (url) {
    const onContact = meetings.find(
      (m) => m.properties?.hs_meeting_external_url === url,
    );
    if (onContact) return { how: 'url', meeting: onContact };
    const global = await client.findMeetingByUrl(url);
    if (global) return { how: 'url_global', meeting: global };
  }

  const when = parseMeetingTime(interaction, transcript);
  if (!when) return { how: 'none', meeting: null };
  const deltaMs = windowMinutes * 60_000;
  const candidates = meetings.filter((m) => {
    const start = parseDt(m.properties?.hs_meeting_start_time);
    return (
      start !== null && Math.abs(start.getTime() - when.getTime()) <= deltaMs
    );
  });
  if (candidates.length === 1) return { how: 'window', meeting: candidates[0] };
  if (candidates.length > 1) return { how: 'ambiguous', meeting: null };
  return { how: 'none', meeting: null };
}
