import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  ExternalIdentity, IdentityStore, LoginDependencies, LoginSession, LoginState,
} from "@studenthub/login-contract";
import { createLoginApplication } from "../src/login-application.js";

const issuer = "https://identity.test.invalid";
const now = 1_800_000_000;
const keys = generateKeyPairSync("ed25519");
const jwk = keys.publicKey.export({ format: "jwk" });

function token(nonce: string, extra: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "EdDSA", kid: "key" });
  const payload = encode({ iss: issuer, aud: "client", sub: "person@example.invalid", nonce,
    exp: now + 300, iat: now, email: "person@example.invalid", ...extra });
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString("base64url")}`;
}

class StableIdentities implements IdentityStore {
  identity: ExternalIdentity | undefined;
  stableId: string | undefined;
  locked = false;
  calls = 0;
  sessions?: Map<string, LoginSession>;
  async findBySubject(): Promise<ExternalIdentity | undefined> { return this.identity; }
  async createForSubject(subjectIssuer: string, subject: string): Promise<ExternalIdentity> {
    return this.identity = { issuer: subjectIssuer, subject, personId: "person-1" };
  }
  async findLegacyMatch(): Promise<undefined> { return undefined; }
  async bindStableId(_issuer: string, _subject: string, value: string) {
    this.calls += 1;
    if (this.locked) return "locked" as const;
    if (this.stableId === undefined) { this.stableId = value; return "bound" as const; }
    if (this.stableId === value) return "matched" as const;
    this.locked = true;
    for (const [id, session] of this.sessions ?? []) {
      if (session.personId === "person-1") this.sessions?.delete(id);
    }
    return "mismatch" as const;
  }
}

function rig(identities: IdentityStore = new StableIdentities()) {
  const states = new Map<string, LoginState>();
  const sessions = new Map<string, LoginSession>();
  if (identities instanceof StableIdentities) identities.sessions = sessions;
  let sequence = 0;
  let nextClaims: Record<string, unknown> = {};
  let activeNonce = "";
  const dependencies: LoginDependencies = {
    identities,
    states: {
      async put(value) { states.set(value.state, value); },
      async consume(state) { const value = states.get(state); states.delete(state); return value; },
    },
    sessions: {
      async put(value) { sessions.set(value.id, value); },
      async get(id) { return sessions.get(id); },
      async delete(id) { sessions.delete(id); },
    },
    entropy: { bytes(length) { sequence += 1; return new Uint8Array(length).fill(sequence); } },
    clock: { nowEpochSeconds: () => now },
    authorization: { roleFor: async () => "candidate" },
    jwks: { resolve: async () => jwk as Record<string, string | undefined> },
    oidc: {
      authorizationUrl: (request) => {
        activeNonce = request.nonce;
        return "https://identity.test.invalid/authorize";
      },
      exchange: async () => {
        return { accessToken: "unused", idToken: token(activeNonce, nextClaims) };
      },
    },
  };
  const app = createLoginApplication(dependencies, { issuer, clientId: "client", clientSecret: "secret",
    callbackUrl: "https://hub.test.invalid/callback", allowedReturnUrls: ["https://hub.test.invalid/home"],
    clockSkewSeconds: 30, subjectPolicy: () => true });
  return { identities, sessions, setClaims(value: Record<string, unknown>) { nextClaims = value; },
    async authorizationFor(sessionId: string) {
      const session = await dependencies.sessions.get(sessionId);
      return session ? dependencies.authorization.roleFor(session.personId) : undefined;
    },
    async login() {
      const start = await app.start({ browserSessionId: "browser", returnTo: "https://hub.test.invalid/home" });
      assert.equal(start.status, 302);
      const state = [...states.keys()][0];
      assert.ok(state);
      return app.callback({ browserSessionId: "browser", state, code: "code" });
    } };
}

test("Q14L_BIND stable claims bind once and matching sign-ins open sessions", async () => {
  for (const claims of [{ hashed_user_id: "stable_id_123" }, { uid: "stable_uid_456" }]) {
    const harness = rig();
    harness.setClaims(claims);
    assert.equal((await harness.login()).status, 302);
    assert.equal((await harness.login()).status, 302);
    assert.equal((harness.identities as StableIdentities).calls, 2);
    assert.equal(harness.sessions.size, 2);
  }
});

test("Q14L_REASSIGN mismatch and persistent lock return generic rejection and revoke access", async () => {
  const harness = rig();
  harness.setClaims({ hashed_user_id: "original_123" });
  assert.equal((await harness.login()).status, 302);
  assert.equal(harness.sessions.size, 1);
  const originalSessionId = [...harness.sessions.keys()][0];
  assert.ok(originalSessionId);
  harness.setClaims({ hashed_user_id: "different_456" });
  assert.deepEqual(await harness.login(), { status: 400, body: { error: "login_rejected" } });
  assert.equal(harness.sessions.size, 0);
  assert.equal(await harness.authorizationFor(originalSessionId), undefined,
    "an authorization read after refusal finds no authenticated principal");
  harness.setClaims({ hashed_user_id: "original_123" });
  assert.deepEqual(await harness.login(), { status: 400, body: { error: "login_rejected" } });
  assert.equal(harness.sessions.size, 0, "no authorization read is reachable without a session");
});

test("Q14L_CLAIMS missing claims preserve old stores; malformed or conflicting claims reject", async () => {
  const oldStore = new StableIdentities();
  oldStore.bindStableId = undefined as never;
  const oldHarness = rig(oldStore);
  assert.equal((await oldHarness.login()).status, 302);
  assert.equal(oldHarness.sessions.size, 1);

  const noClaimHarness = rig();
  assert.equal((await noClaimHarness.login()).status, 302);
  assert.equal(noClaimHarness.sessions.size, 1);
  assert.equal((noClaimHarness.identities as StableIdentities).calls, 0);

  for (const claims of [
    { hashed_user_id: "short" }, { uid: "invalid.value" },
    { uid: "x".repeat(129) }, { hashed_user_id: "stable_123", uid: "stable_456" },
  ]) {
    const harness = rig();
    harness.setClaims(claims);
    assert.deepEqual(await harness.login(), { status: 400, body: { error: "login_rejected" } });
    assert.equal(harness.sessions.size, 0);
  }
});

test("Q14L_DOCS documents the active guard and no-claim residual risk", async () => {
  const docs = await readFile("docs/authz-roles.md", "utf8");
  assert.match(docs, /Universe reassignment guard — active when a stable-id claim is present/);
  assert.match(docs, /If Universe supplies no stable-id claim/);
  assert.match(docs, /immutable UUID as the OIDC subject/);
});
