export { signAssertion } from "./sign.js";
export { verifyAssertion, MemoryReplayStore } from "./verify.js";
export { generateEd25519KeyPair } from "./keys.js";
export type { Ed25519KeyPair } from "./keys.js";
export {
  AssertionErrorCode,
  ENVELOPE_PREFIX,
  USER_EMAIL_SUBJECT_POLICY,
  HASHED_USER_ID_SUBJECT_POLICY,
  UNIVERSE_SUBJECT_POLICY,
} from "./types.js";
export type {
  ActorAssertionClaims,
  ActorAssertionAct,
  SubjectPolicy,
  KeyResolver,
  ReplayStore,
  VerifyOptions,
  VerifyResult,
} from "./types.js";
