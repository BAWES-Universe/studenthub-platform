import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  ClaimedProfile, ExternalIdentity, IdentityStore, LoginSession, LoginState,
} from "@studenthub/login-contract";
import { createLoginApplication } from "../src/login-application.js";

const issuer = "https://universe.test.invalid";
const subject = "student@example.invalid";
const keyPair = generateKeyPairSync("ed25519");
const publicJwk = keyPair.publicKey.export({ format: "jwk" }) as Record<string, string>;

function wire(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

class GuardedIdentities implements IdentityStore {
  identity: ExternalIdentity | undefined;
  stableId: string | undefined;
  locked = false;
  bindCalls = 0;

  async findBySubject(): Promise<ExternalIdentity | undefined> { return this.identity; }
  async createForSubject(
    identityIssuer: string, identitySubject: string, _claims: ClaimedProfile,
  ): Promise<ExternalIdentity> {
    return this.identity ??= { issuer: identityIssuer, subject: identitySubject, personId: "person-1" };
  }
  async findLegacyMatch(): Promise<undefined> { return undefined; }
  async bindStableId(
    _issuer: string, _subject: string, stableUserId: string,
  ): Promise<"bound" | "matched" | "mismatch" | "locked"> {
    this.bindCalls += 1;
    if (this.locked) return "locked";
    if (this.stableId === undefined) {
      this.stableId = stableUserId;
      return "bound";
    }
    if (this.stableId === stableUserId) return "matched";
    this.locked = true;
    this.sessions?.clear();
    return "mismatch";
  }
  sessions?: Map<string, LoginSession>;
}

function rig(withBind = true) {
  const states = new Map<string, LoginState>();
  const sessions = new Map<string, LoginSession>();
  const identities = new GuardedIdentities();
  identities.sessions = sessions;
  if (!withBind) identities.bindStableId = undefined as never;
  let claims: Record<string, unknown> = {};
  let latestState: LoginState | undefined;
  let entropy = 1;
  const app = createLoginApplication({
    states: {
      async put(state) { states.set(state.state, state); latestState = state; },
      async consume(state) { const found = states.get(state); states.delete(state); return found; },
    },
    sessions: {
      async put(session) { sessions.set(session.id, session); },
      async get(id) { return sessions.get(id); },
      async delete(id) { sessions.delete(id); },
    },
    identities,
    authorization: { async roleFor() { return "candidate"; } },
    clock: { nowEpochSeconds: () => 1_800_000_000 },
    entropy: {
      bytes(length) {
        const result = new Uint8Array(length).fill(entropy);
        entropy += 1;
        return result;
      },
    },
    jwks: {
      async resolve() { return { ...publicJwk, kid: "key-1", alg: "EdDSA", use: "sig" }; },
    },
    oidc: {
      authorizationUrl(request) { return `https://universe.test.invalid/authorize?state=${request.state}`; },
      async exchange() {
        const state = latestState;
        assert.ok(state);
        const header = wire({ alg: "EdDSA", kid: "key-1" });
        const payload = wire({
          iss: issuer, aud: "studenthub", sub: subject, nonce: state.nonce,
          exp: 1_800_000_300, iat: 1_800_000_000, email: subject, ...claims,
        });
        return {
          accessToken: "unused",
          idToken: `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keyPair.privateKey).toString("base64url")}`,
        };
      },
    },
  }, {
    issuer, clientId: "studenthub", clientSecret: "secret",
    callbackUrl: "https://studenthub.test.invalid/callback",
    allowedReturnUrls: ["https://studenthub.test.invalid/home"],
    clockSkewSeconds: 30,
    subjectPolicy: () => true,
  });
  async function login(nextClaims: Record<string, unknown>) {
    claims = nextClaims;
    const started = await app.start({
      browserSessionId: "browser", returnTo: "https://studenthub.test.invalid/home",
    });
    const state = new URL(started.headers?.location ?? "").searchParams.get("state");
    assert.ok(state);
    return app.callback({ browserSessionId: "browser", state, code: "code" });
  }
  return { app, identities, sessions, login };
}

test("Q14L_BIND first stable id binds and the matching id opens sessions", async () => {
  const testRig = rig();
  assert.equal((await testRig.login({ hashed_user_id: "stable_id_123" })).status, 302);
  assert.equal(testRig.identities.stableId, "stable_id_123");
  assert.equal((await testRig.login({ hashed_user_id: "stable_id_123" })).status, 302);
  assert.equal(testRig.sessions.size, 2);

  const uidRig = rig();
  assert.equal((await uidRig.login({ uid: "uid_value_123" })).status, 302);
  assert.equal(uidRig.identities.stableId, "uid_value_123");
});

test("Q14L_REASSIGN mismatch is generic, revokes sessions, and remains locked", async () => {
  const testRig = rig();
  await testRig.login({ hashed_user_id: "original_id_123" });
  const response = await testRig.login({ hashed_user_id: "different_id_456" });
  assert.deepEqual(response, { status: 400, body: { error: "login_rejected" } });
  assert.equal(testRig.sessions.size, 0);
  assert.equal(testRig.identities.locked, true);
  assert.deepEqual(await testRig.login({ hashed_user_id: "original_id_123" }), response);
  assert.equal(testRig.sessions.size, 0, "no session can reach grants, links, records or finance");
});

test("Q14L_CLAIMS absent claims and optional stores retain the old path; malformed claims reject", async () => {
  const noClaim = rig();
  assert.equal((await noClaim.login({})).status, 302);
  assert.equal(noClaim.identities.bindCalls, 0);
  const oldStore = rig(false);
  assert.equal((await oldStore.login({ hashed_user_id: "stable_id_123" })).status, 302);

  for (const malformed of [
    { hashed_user_id: "short" },
    { hashed_user_id: "bad value!" },
    { hashed_user_id: "x".repeat(129) },
    { hashed_user_id: "stable_id_123", uid: "different_id_456" },
  ]) {
    const malformedRig = rig();
    assert.deepEqual(await malformedRig.login(malformed), {
      status: 400, body: { error: "login_rejected" },
    });
    assert.equal(malformedRig.sessions.size, 0);
  }
});

test("Q14L_DOCS documents the active guard, residual risk and immutable-subject fix", async () => {
  const docs = await readFile("docs/authz-roles.md", "utf8");
  assert.match(docs, /Universe reassignment guard/);
  assert.match(docs, /token carries no stable-id claim/);
  assert.match(docs, /immutable UUID as the OIDC subject/);
});
