// Generated from scripts/transcript_processing/push_to_pipedrive.py ACTIVITY_FIELDS
// (mla-notes-sync, feature/v2). Same fields, same order, same labels as the Python push.
export type FieldType =
  'text' | 'array' | 'competitor_mentions' | 'communication_prefs';

export const ACTIVITY_FIELDS: ReadonlyArray<
  readonly [string, string, FieldType]
> = [
  ['summary', 'Meeting Summary', 'text'],
  ['call_type', 'Call Type', 'text'],
  ['call_sentiment', 'Sentiment', 'text'],
  ['communication_style', 'Communication Style', 'text'],
  ['decision_style', 'Decision Style', 'text'],
  ['relationship_temp', 'Relationship Temperature', 'text'],
  ['likelihood_to_proceed', 'Likelihood to Proceed', 'text'],
  ['next_steps', 'Next Steps', 'text'],
  ['next_touchpoint', 'Next Touchpoint', 'text'],
  ['pain_points', 'Pain Points', 'array'],
  ['objections', 'Objections', 'array'],
  ['desired_outcomes', 'Desired Outcomes', 'array'],
  ['mla_capabilities_discussed', 'MLA Capabilities Discussed', 'array'],
  ['proposals_made', 'Proposals Made', 'array'],
  ['what_resonated', 'What Resonated', 'array'],
  ['mla_action_items', 'Action Items (MLA)', 'array'],
  ['client_action_items', 'Action Items (Client)', 'array'],
  ['materials_to_send', 'Materials to Send', 'array'],
  ['notes_discussed', 'Notes Discussed', 'array'],
  ['red_flags', 'Red Flags', 'array'],
  ['notable_quotes', 'Notable Quotes', 'array'],
  ['hobbies_interests', 'Hobbies/Interests', 'array'],
  ['family_details', 'Family Details', 'array'],
  ['travel', 'Travel', 'array'],
  ['personal_excitement', 'Personal Excitement', 'array'],
  ['competitor_mentions', 'Competitor Mentions', 'competitor_mentions'],
  ['communication_prefs', 'Communication Preferences', 'communication_prefs'],
];
