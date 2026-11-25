/**
 * Access lane U-03: the person's own account page, where they see where they
 * are signed in to StudentHub and can sign out everywhere.
 *
 * Signing out everywhere ends every StudentHub session of the person, the
 * current one included, on the next request of each. It does not end the
 * person's Universe sign-in: that is Universe's, and ordinary sign-out asks
 * Universe to end it for this browser.
 */
export interface AccountSession {
  /** The session the request came with. */
  readonly current: boolean;
  /** ISO time the session started; null for sessions older than the record. */
  readonly signedInAt: string | null;
  readonly expiresAt: string;
}

/** The person's live sessions, newest first and capped, with the real number of live sessions. */
export interface AccountSessionList {
  readonly sessions: readonly AccountSession[];
  /** Every live session of the person, uncapped: what signing out everywhere ends. */
  readonly live: number;
}

export interface AccountSessionsStore {
  /** The person's live sessions; `currentSessionToken` is the caller's own cookie value. */
  list(personId: string, currentSessionToken: string): Promise<AccountSessionList>;
  /** Ends every session of the person; answers how many. */
  endAll(personId: string): Promise<number>;
}
