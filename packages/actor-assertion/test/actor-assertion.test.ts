import { describe, it, expect, beforeAll } from "vitest";
import {
  signAssertion,
  verifyAssertion,
  generateEd25519KeyPair,
  ActorAssertionClaims,
  MemoryReplayStore,
  AssertionErrorCode,
  AUTHENTIK_SUBJECT_POLICY,
} from "../src/index.js";

const ISS = "bawes.universe";
const AUD = "studenthub/tools/call:candidate.prepare";
const OTHER_AUD = "studenthub/tools/call:shift.publish";

let keyPair: Awaited<ReturnType<typeof generateEd25519KeyPair>>;
let otherKeyPair: Awaited<ReturnType<typeof generateEd25519KeyPair>>;
const resolver = async (iss: string) =>
  iss === ISS ? keyPair.publicKeyPem : undefined;

function claims(over: Partial<ActorAssertionClaims> = {}): ActorAssertionClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    iss: ISS,
    aud: AUD,
    sub: "e5f2c9a1-4b7d-4a3e-9c8f-2d1b6a0e4f77",
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
    ...over,
  };
}

beforeAll(async () => {
  keyPair = await generateEd25519KeyPair();
  otherKeyPair = await generateEd25519KeyPair();
});

describe("actor assertion v1 — acceptance corpus (SHU-0031)", () => {
  it("valid assertion passes only for its intended service/action", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
      expectedSubject: "e5f2c9a1-4b7d-4a3e-9c8f-2d1b6a0e4f77",
    });
    expect(res.ok).toBe(true);
  });

  it("expired assertion fails closed", async () => {
    const token = await signAssertion(
      claims({ exp: Math.floor(Date.now() / 1000) - 10 }),
      keyPair.privateKeyPem,
    );
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.EXPIRED);
  });

  it("replayed jti fails closed on second use", async () => {
    const store = new MemoryReplayStore();
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const first = await verifyAssertion(token, resolver, store, { expectedAudience: AUD, subjectPolicy: AUTHENTIK_SUBJECT_POLICY });
    expect(first.ok).toBe(true);
    const second = await verifyAssertion(token, resolver, store, { expectedAudience: AUD, subjectPolicy: AUTHENTIK_SUBJECT_POLICY });
    expect(second.ok).toBe(false);
    expect(second.code).toBe(AssertionErrorCode.REPLAYED);
  });

  it("wrong-audience assertion fails closed", async () => {
    const token = await signAssertion(
      claims({ aud: OTHER_AUD }),
      keyPair.privateKeyPem,
    );
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.AUD_MISMATCH);
  });

  it("wrong-subject assertion fails closed", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
      expectedSubject: "someone-else-uuid",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.WRONG_SUBJECT);
  });

  it("guest subject fails closed", async () => {
    const token = await signAssertion(claims({ sub: "guest" }), keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.SUBJECT_FORMAT);
  });

  it("anonymous subject fails closed", async () => {
    const token = await signAssertion(claims({ sub: "anonymous" }), keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.SUBJECT_FORMAT);
  });

  it("missing subject fails closed", async () => {
    const c = claims() as Record<string, unknown>;
    delete c.sub;
    const token = await signAssertion(c as unknown as ActorAssertionClaims, keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
  });

  it("malformed token fails closed", async () => {
    const res = await verifyAssertion("not-an-assertion", resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.MALFORMED);
  });

  it("tampered payload (signature invalid) fails closed", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[2]!, "base64url").toString());
    payload.sub = "attacker-uuid";
    const forged = `${parts[0]}.${parts[1]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[3]}`;
    const res = await verifyAssertion(forged, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.BAD_SIGNATURE);
  });

  it("unsigned/truncated token fails closed", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const truncated = token.split(".").slice(0, 3).join(".");
    const res = await verifyAssertion(truncated, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.MALFORMED);
  });

  it("unknown issuer fails closed", async () => {
    const token = await signAssertion(claims({ iss: "attacker.issuer" }), otherKeyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.UNKNOWN_ISSUER);
  });

  it("signature from a different key fails closed", async () => {
    const token = await signAssertion(claims(), otherKeyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.BAD_SIGNATURE);
  });

  it("future iat beyond skew bound fails closed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signAssertion(
      claims({ iat: now + 3600, exp: now + 7200 }),
      keyPair.privateKeyPem,
    );
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.FUTURE_IAT);
  });

  it("valid assertion must NOT contain private key material", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    expect(token).not.toContain("PRIVATE KEY");
    expect(token).not.toContain(keyPair.privateKeyPem.slice(20, 60));
  });
});

describe("standard amendments (SHU-49)", () => {
  it("carries the optional act claim through signing and verification", async () => {
    const token = await signAssertion(
      claims({ act: { org: "org-acme", role: "recruiter" } }),
      keyPair.privateKeyPem,
    );
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.act).toEqual({ org: "org-acme", role: "recruiter" });
  });

  it("stays wire-compatible: an assertion with no act still verifies", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.act).toBeUndefined();
  });

  it("rejects a malformed act rather than ignoring it", async () => {
    const token = await signAssertion(
      claims({ act: { org: "" } } as never),
      keyPair.privateKeyPem,
    );
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects machine subjects that no denylist would have enumerated", async () => {
    for (const sub of ["anon", "system", "service-account-indexer", "svc:indexer"]) {
      const token = await signAssertion(claims({ sub }), keyPair.privateKeyPem);
      const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
        expectedAudience: AUD,
        subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(AssertionErrorCode.SUBJECT_FORMAT);
    }
  });

  it("selects the signing key by kid when the assertion carries one", async () => {
    const byKid = async (iss: string, kid?: string) =>
      iss === ISS && kid === "k1" ? keyPair.publicKeyPem : undefined;
    const good = await signAssertion(claims({ kid: "k1" }), keyPair.privateKeyPem);
    const bad = await signAssertion(claims({ kid: "retired" }), keyPair.privateKeyPem);
    const opts = { expectedAudience: AUD, subjectPolicy: AUTHENTIK_SUBJECT_POLICY };
    expect((await verifyAssertion(good, byKid, new MemoryReplayStore(), opts)).ok).toBe(true);
    const res = await verifyAssertion(bad, byKid, new MemoryReplayStore(), opts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(AssertionErrorCode.UNKNOWN_ISSUER);
  });
});
