export interface WiringSettings {
  readonly databaseUrl: string;
  readonly safeWriteKey: Buffer | undefined;
}

export interface Wired<T> {
  readonly services: T;
  close(): Promise<void>;
}
