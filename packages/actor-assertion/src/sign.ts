import { createPrivateKey, sign } from "node:crypto";
import { ENVELOPE_PREFIX, ActorAssertionClaims } from "./types.js";

function b64u(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Sign claims into a compact destination-bound assertion envelope:
 * `bawes-aa.v1.<base64url(claimsJson)>.<base64url(ed25519sig)>`
 * Signature covers the prefix + payload, binding the version into the signature.
 */
export async function signAssertion(
  claims: ActorAssertionClaims,
  privateKeyPem: string,
): Promise<string> {
  const payload = b64u(JSON.stringify(claims));
  const signingInput = `${ENVELOPE_PREFIX}.${payload}`;
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${b64u(signature)}`;
}
