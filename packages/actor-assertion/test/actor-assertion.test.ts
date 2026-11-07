import { describe, it, expect, beforeAll } from "vitest";
import {
  signAssertion,
  verifyAssertion,
  generateEd25519KeyPair,
  ActorAssertionClaims,
  MemoryReplayStore,
  AssertionErrorCode,
  UNIVERSE_SUBJECT_POLICY,
  USER_EMAIL_SUBJECT_POLICY,
  HASHED_USER_ID_SUBJECT_POLICY,
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
    sub: "student@bawes.net",
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
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
      expectedSubject: "student@bawes.net",
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
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.EXPIRED);
  });

  it("replayed jti fails closed on second use", async () => {
    const store = new MemoryReplayStore();
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const first = await verifyAssertion(token, resolver, store, { expectedAudience: AUD, subjectPolicy: UNIVERSE_SUBJECT_POLICY });
    expect(first.ok).toBe(true);
    const second = await verifyAssertion(token, resolver, store, { expectedAudience: AUD, subjectPolicy: UNIVERSE_SUBJECT_POLICY });
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
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.AUD_MISMATCH);
  });

  it("wrong-subject assertion fails closed", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
      expectedSubject: "someone-else@bawes.net",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.WRONG_SUBJECT);
  });

  it("guest subject fails closed", async () => {
    const token = await signAssertion(claims({ sub: "guest" }), keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.SUBJECT_FORMAT);
  });

  it("anonymous subject fails closed", async () => {
    const token = await signAssertion(claims({ sub: "anonymous" }), keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
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
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
  });

  it("malformed token fails closed", async () => {
    const res = await verifyAssertion("not-an-assertion", resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.MALFORMED);
  });

  it("tampered payload (signature invalid) fails closed", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[2]!, "base64url").toString());
    payload.sub = "attacker@evil.example";
    const forged = `${parts[0]}.${parts[1]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[3]}`;
    const res = await verifyAssertion(forged, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.BAD_SIGNATURE);
  });

  it("unsigned/truncated token fails closed", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const truncated = token.split(".").slice(0, 3).join(".");
    const res = await verifyAssertion(truncated, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.MALFORMED);
  });

  it("unknown issuer fails closed", async () => {
    const token = await signAssertion(claims({ iss: "attacker.issuer" }), otherKeyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(AssertionErrorCode.UNKNOWN_ISSUER);
  });

  it("signature from a different key fails closed", async () => {
    const token = await signAssertion(claims(), otherKeyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
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
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
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
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.act).toEqual({ org: "org-acme", role: "recruiter" });
  });

  it("stays wire-compatible: an assertion with no act still verifies", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
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
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects machine subjects that no denylist would have enumerated", async () => {
    for (const sub of ["anon", "system", "service-account-indexer", "svc:indexer", "guest", "e5f2c9a1-4b7d-4a3e-9c8f-2d1b6a0e4f77"]) {
      const token = await signAssertion(claims({ sub }), keyPair.privateKeyPem);
      const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
        expectedAudience: AUD,
        subjectPolicy: UNIVERSE_SUBJECT_POLICY,
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
    const opts = { expectedAudience: AUD, subjectPolicy: UNIVERSE_SUBJECT_POLICY };
    expect((await verifyAssertion(good, byKid, new MemoryReplayStore(), opts)).ok).toBe(true);
    const res = await verifyAssertion(bad, byKid, new MemoryReplayStore(), opts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(AssertionErrorCode.UNKNOWN_ISSUER);
  });
});

describe("subject policy matches what live Authentik emits (SHU-49)", () => {
  it("accepts a real Universe subject — sub_mode=user_email", async () => {
    const token = await signAssertion(claims({ sub: "khalid@bawes.net" }), keyPair.privateKeyPem);
    const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
      expectedAudience: AUD,
      subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    });
    expect(res.ok).toBe(true);
  });

  it("the withdrawn 32-hex/UUID reference pattern would have denied every real subject", () => {
    // Regression guard for the pattern this file shipped before 2026-09-04.
    const withdrawn =
      /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
    for (const realSubject of ["khalid@bawes.net", "student@bawes.net", "a.b+c@sub.example.org"]) {
      expect(withdrawn.test(realSubject)).toBe(false);
      expect(USER_EMAIL_SUBJECT_POLICY.humanSubjectPattern.test(realSubject)).toBe(true);
    }
  });

  it("sub_mode is per-provider: the two live modes do not accept each other", () => {
    const email = "khalid@bawes.net";
    const hashed = "9f1c2b7e4a6d8f0b3c5e7a9d1f2b4c6e";
    expect(USER_EMAIL_SUBJECT_POLICY.humanSubjectPattern.test(email)).toBe(true);
    expect(USER_EMAIL_SUBJECT_POLICY.humanSubjectPattern.test(hashed)).toBe(false);
    expect(HASHED_USER_ID_SUBJECT_POLICY.humanSubjectPattern.test(hashed)).toBe(true);
    expect(HASHED_USER_ID_SUBJECT_POLICY.humanSubjectPattern.test(email)).toBe(false);
  });

  it("still rejects machine and malformed subjects under the email mode", async () => {
    for (const sub of ["anonymous", "service-account-indexer", "no-at-sign", "@bawes.net", "a@b"]) {
      const token = await signAssertion(claims({ sub }), keyPair.privateKeyPem);
      const res = await verifyAssertion(token, resolver, new MemoryReplayStore(), {
        expectedAudience: AUD,
        subjectPolicy: UNIVERSE_SUBJECT_POLICY,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(AssertionErrorCode.SUBJECT_FORMAT);
    }
  });
});

describe("dependency failures and replay scoping (PR #13 review)", () => {
  const opts = { expectedAudience: AUD, subjectPolicy: UNIVERSE_SUBJECT_POLICY };

  it("a rejecting key resolver becomes a typed denial, not a thrown rejection", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const exploding = async () => {
      throw new Error("registry down");
    };
    const res = await verifyAssertion(token, exploding, new MemoryReplayStore(), opts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(AssertionErrorCode.UNAVAILABLE);
  });

  it("a rejecting replay store denies rather than silently skipping replay protection", async () => {
    const token = await signAssertion(claims(), keyPair.privateKeyPem);
    const broken = {
      consume() {
        throw new Error("redis down");
      },
    };
    const res = await verifyAssertion(token, resolver, broken, opts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(AssertionErrorCode.UNAVAILABLE);
  });

  it("replay state is scoped by issuer: the same jti from two issuers both verify", async () => {
    const otherIss = "other.tenant";
    const multiResolver = async (iss: string) =>
      iss === ISS || iss === otherIss ? keyPair.publicKeyPem : undefined;
    const store = new MemoryReplayStore();

    const a = await signAssertion(claims({ jti: "shared-id" }), keyPair.privateKeyPem);
    const b = await signAssertion(
      claims({ iss: otherIss, jti: "shared-id" }),
      keyPair.privateKeyPem,
    );

    expect((await verifyAssertion(a, multiResolver, store, opts)).ok).toBe(true);
    const second = await verifyAssertion(b, multiResolver, store, opts);
    expect(second.ok).toBe(true);

    // ...and a genuine replay within one issuer is still caught.
    const replay = await verifyAssertion(a, multiResolver, store, opts);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe(AssertionErrorCode.REPLAYED);
  });
});

describe("strict lifetime and fresh-clock verification", () => {
  const options = () => ({
    expectedAudience: AUD, subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    maxLifetimeSeconds: 60, maxIatSkewSeconds: 5,
    wallClock: () => 1000, monotonicClock: () => 0,
  });
  const token = (over: Partial<ActorAssertionClaims> = {}) =>
    signAssertion(claims({ iat: 1000, exp: 1060, ...over }), keyPair.privateKeyPem);
  const check = async (over = {}, opts = {}, store = new MemoryReplayStore()) =>
    verifyAssertion(await token(over), resolver, store, { ...options(), ...opts });

  it("accepts exact lifetime and future-iat boundaries", async () => {
    expect((await check()).ok).toBe(true);
    expect((await check({ iat: 1005, exp: 1065 })).ok).toBe(true);
    expect((await check({ iat: 1006, exp: 1066 })).code).toBe(AssertionErrorCode.FUTURE_IAT);
    expect((await check({ iat: 940, exp: 1000 })).code).toBe(AssertionErrorCode.EXPIRED);
    expect((await check({ iat: 999, exp: 1000.1 })).ok).toBe(true);
  });

  it.each([0, -1, 3601, 1.5, NaN, Infinity, -Infinity, null, "60"])(
    "invalid strict lifetime %s denies before key lookup", async (maxLifetimeSeconds) => {
      let lookups = 0;
      const res = await verifyAssertion(await token(), async () => { lookups++; return keyPair.publicKeyPem; },
        new MemoryReplayStore(), { ...options(), maxLifetimeSeconds } as never);
      expect(res.code).toBe(AssertionErrorCode.CONFIG);
      expect(lookups).toBe(0);
    });
  it.each([-1, 301, 0.5, NaN, Infinity, null, "5"])("invalid strict skew %s", async (maxIatSkewSeconds) => {
    let lookups = 0;
    const res = await verifyAssertion(await token(), async () => { lookups++; return keyPair.publicKeyPem; },
      new MemoryReplayStore(), { ...options(), maxIatSkewSeconds } as never);
    expect(res.code).toBe(AssertionErrorCode.CONFIG);
    expect(lookups).toBe(0);
  });
  it("accepts minimum/maximum policy bounds", async () => {
    expect((await check({ exp: 1001 }, { maxLifetimeSeconds: 1, maxIatSkewSeconds: 0 })).ok).toBe(true);
    expect((await check({ exp: 4600 }, { maxLifetimeSeconds: 3600, maxIatSkewSeconds: 300 })).ok).toBe(true);
  });
  it.each([{ exp: 1000 }, { exp: 999 }, { exp: 1061 }])("rejects invalid lifetime %j", async (over) => {
    expect((await check(over)).code).toBe(AssertionErrorCode.LIFETIME);
  });
  it("keeps legacy numeric now and boolean replay stores", async () => {
    const t = await token({ exp: 9999 });
    const legacy = { expectedAudience: AUD, subjectPolicy: UNIVERSE_SUBJECT_POLICY, now: 1000 };
    expect((await verifyAssertion(t, resolver, { consume: () => false }, legacy)).ok).toBe(true);
    expect((await verifyAssertion(t, resolver, { consume: async () => true }, legacy)).code).toBe(AssertionErrorCode.REPLAYED);
    expect((await verifyAssertion(t, resolver, { consume: () => false }, { ...legacy, now: 9999 })).code).toBe(AssertionErrorCode.EXPIRED);
  });
  it("never treats fixed numeric now as a fresh strict clock", async () => {
    expect((await check({}, { now: 0 })).ok).toBe(true);
    expect((await check({}, { now: 1000, wallClock: () => 1060 })).code).toBe(AssertionErrorCode.EXPIRED);
  });
  it("rechecks expiration after an asynchronous key resolver", async () => {
    let wall = 1000;
    let consumes = 0;
    const res = await verifyAssertion(await token(), async () => {
      await Promise.resolve(); wall = 1060; return keyPair.publicKeyPem;
    }, { consume: () => { consumes++; return false; } }, { ...options(), wallClock: () => wall });
    expect(res.code).toBe(AssertionErrorCode.EXPIRED);
    expect(consumes).toBe(0);
  });
  it.each([10, 10.001])("monotonic deadline boundary %s", async (elapsed) => {
    let mono = 0;
    const res = await verifyAssertion(await token(), async () => { mono = elapsed; return keyPair.publicKeyPem; },
      new MemoryReplayStore(), { ...options(), monotonicClock: () => mono });
    expect(res.ok).toBe(elapsed === 10);
    if (elapsed > 10) expect(res.code).toBe(AssertionErrorCode.UNAVAILABLE);
  });
  it("checks expiry and deadline again after replay consumption", async () => {
    for (const deadline of [false, true]) {
      let wall = 1000, mono = 0;
      const res = await verifyAssertion(await token(), resolver, { consume: async () => {
        if (deadline) mono = 11; else wall = 1060;
        return false;
      } }, { ...options(), wallClock: () => wall, monotonicClock: () => mono });
      expect(res.code).toBe(deadline ? AssertionErrorCode.UNAVAILABLE : AssertionErrorCode.EXPIRED);
    }
  });
  it.each([NaN, Infinity, -Infinity])("fails closed on invalid clocks %s", async (value) => {
    expect((await check({}, { wallClock: () => value })).code).toBe(AssertionErrorCode.UNAVAILABLE);
    expect((await check({}, { monotonicClock: () => value })).code).toBe(AssertionErrorCode.UNAVAILABLE);
  });
  it("fails closed on throwing or regressing clocks", async () => {
    expect((await check({}, { wallClock: () => { throw Error("clock"); } })).code).toBe(AssertionErrorCode.UNAVAILABLE);
    for (const clock of ["wallClock", "monotonicClock"]) {
      let n = 0;
      expect((await check({}, { [clock]: () => clock === "wallClock" ? 1000 - n++ : -n++ })).code).toBe(AssertionErrorCode.UNAVAILABLE);
    }
  });
  it.each([
    ["consumed", undefined], ["replayed", AssertionErrorCode.REPLAYED],
    ["expired", AssertionErrorCode.EXPIRED], ["future_iat", AssertionErrorCode.FUTURE_IAT],
    [undefined, AssertionErrorCode.UNAVAILABLE], ["unexpected", AssertionErrorCode.UNAVAILABLE],
  ])("maps explicit replay outcome %s", async (outcome, code) => {
    const res = await verifyAssertion(await token(), resolver, { consume: (...args: unknown[]) => {
      expect(args[4]).toEqual({ issuedAt: 1000, maxIatSkewSeconds: 5 });
      return outcome;
    } } as never, options());
    expect(res.ok).toBe(code === undefined);
    if (code) expect(res.code).toBe(code);
  });
  it("preserves explicit expired denial even when the store exceeds the deadline", async () => {
    let mono = 0;
    const res = await verifyAssertion(await token(), resolver, { consume: async () => {
      mono = 11; return "expired" as const;
    } }, { ...options(), monotonicClock: () => mono });
    expect(res.code).toBe(AssertionErrorCode.EXPIRED);
  });
  it("denies database exceptions", async () => {
    const res = await verifyAssertion(await token(), resolver, { consume: async () => { throw Error("db offline"); } }, options());
    expect(res.code).toBe(AssertionErrorCode.UNAVAILABLE);
  });
});
