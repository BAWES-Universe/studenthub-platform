export interface WiringSettings {
  readonly databaseUrl: string;
  readonly safeWriteKey: Buffer | undefined;
  /** The validated OIDC_CALLBACK_URL; its origin is the gateway origin that same-origin form posts must carry. */
  readonly callbackUrl?: string;
}

export interface Wired<T> {
  readonly services: T;
  close(): Promise<void>;
}
