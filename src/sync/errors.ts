export class HubSpotError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'HubSpotError';
  }
}

export class HubSpotConflict extends HubSpotError {
  constructor(
    message: string,
    public readonly existingId: string | null = null,
  ) {
    super(message, 409, false);
    this.name = 'HubSpotConflict';
  }
}

/** A provisional contact was created in HubSpot but its ledger row could not be written. */
export class LedgerWriteError extends HubSpotError {
  constructor(
    message: string,
    public readonly contactId: string,
  ) {
    super(message, null, true);
    this.name = 'LedgerWriteError';
  }
}
