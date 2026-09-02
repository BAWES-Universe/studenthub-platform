export { signAssertion } from "./sign.js";
export { verifyAssertion, MemoryReplayStore } from "./verify.js";
export { generateEd25519KeyPair } from "./keys.js";
export type { Ed25519KeyPair } from "./keys.js";
export {
  AssertionErrorCode,
  ENVELOPE_PREFIX,
  GUEST_SUBJECTS,
} from "./types.js";
export type {
  ActorAssertionClaims,
  KeyResolver,
  ReplayStore,
  VerifyOptions,
  VerifyResult,
} from "./types.js";
