export const PROVISIONAL_PROPERTY = 'mla_provisional';

export const PROVISIONAL_PROPERTY_SPEC = {
  name: PROVISIONAL_PROPERTY,
  label: 'MLA provisional contact',
  description:
    'Set by the MLA meeting-summary push when it created this contact because no HubSpot ' +
    'contact existed for a meeting participant. Review, then merge into the correct contact or clear.',
  groupName: 'contactinformation',
  type: 'enumeration',
  fieldType: 'booleancheckbox',
  options: [
    { label: 'Yes', value: 'true', displayOrder: 0, hidden: false },
    { label: 'No', value: 'false', displayOrder: 1, hidden: false },
  ],
};

export const MEETING_PROPERTIES = [
  'hs_meeting_title',
  'hs_meeting_external_url',
  'hs_meeting_start_time',
  'hs_internal_meeting_notes',
  'hs_timestamp',
  'hs_meeting_outcome',
];

export const MEETING_TO_CONTACT_ASSOC_TYPE_ID = 200; // HUBSPOT_DEFINED meeting -> contact
export const DEFAULT_WINDOW_MINUTES = 30;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const MAX_HTTP_RETRIES = 3;
export const MAX_RETRY_DELAY = 30; // seconds; caps Retry-After so a request never stalls long
export const CLAIM_LEASE_MINUTES = 10;
export const LEDGER_FAILURE_PREFIX =
  'provisional contact created but ledger write failed';
export const HUBSPOT_BASE = 'https://api.hubapi.com';

export const BLOCK_END = '<!-- /mla-summary -->';
export const blockStart = (id: string | number) => `<!-- mla-summary:${id} -->`;
