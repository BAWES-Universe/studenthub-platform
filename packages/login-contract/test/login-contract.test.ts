import assert from "node:assert/strict";
import test from "node:test";

import { LOGIN_CONTRACT_SCENARIOS, LOGIN_CONTRACT_VERSION, runLoginConformance } from "../src/index.js";
import { referenceLoginFactory, type ReferenceFaults } from "./reference-adapter.js";

test("the conforming deterministic reference adapter satisfies every SHU-60 scenario", async () => {
  const report = await runLoginConformance(referenceLoginFactory());
  assert.equal(report.ok, true, JSON.stringify(report.results, null, 2));
  assert.deepEqual(report.results.map(({ name }) => name), LOGIN_CONTRACT_SCENARIOS);
  assert.ok(report.results.length >= 6);
  assert.equal(LOGIN_CONTRACT_VERSION, "1.0.0");
});

const CONTROL_MUTATIONS: ReadonlyArray<readonly [keyof ReferenceFaults, string, string]> = [
  ["leakBrowserSecrets", "browser output secrecy", LOGIN_CONTRACT_SCENARIOS[0]!],
  ["leakRejectedSecrets", "rejected browser output secrecy", LOGIN_CONTRACT_SCENARIOS[0]!],
  ["skipCodeExchange", "server-side authorization-code exchange", LOGIN_CONTRACT_SCENARIOS[0]!],
  ["shortState", "CSPRNG state", LOGIN_CONTRACT_SCENARIOS[0]!],
  ["skipStateBinding", "browser-session binding", LOGIN_CONTRACT_SCENARIOS[1]!],
  ["reusableState", "one-time state", LOGIN_CONTRACT_SCENARIOS[1]!],
  ["skipPkce", "PKCE S256", LOGIN_CONTRACT_SCENARIOS[0]!],
  ["skipNonce", "nonce issuance", LOGIN_CONTRACT_SCENARIOS[0]!],
  ["unsafeRedirect", "exact redirect allowlist", LOGIN_CONTRACT_SCENARIOS[2]!],
  ["skipSignature", "ID-token signature", LOGIN_CONTRACT_SCENARIOS[3]!],
  ["skipIssuer", "issuer", LOGIN_CONTRACT_SCENARIOS[3]!],
  ["skipAudience", "audience", LOGIN_CONTRACT_SCENARIOS[3]!],
  ["skipExpiry", "expiry", LOGIN_CONTRACT_SCENARIOS[3]!],
  ["skipIssuedAt", "issued-at skew", LOGIN_CONTRACT_SCENARIOS[3]!],
  ["skipSubjectPolicy", "UNIVERSE_SUBJECT_POLICY", LOGIN_CONTRACT_SCENARIOS[4]!],
  ["emailSubjectFallback", "no email-as-subject fallback", LOGIN_CONTRACT_SCENARIOS[4]!],
  ["legacyProfileMatch", "no legacy profile matching", LOGIN_CONTRACT_SCENARIOS[4]!],
  ["bindSubjectToEmail", "stable issuer/subject binding", LOGIN_CONTRACT_SCENARIOS[4]!],
  ["trustClientRole", "server-side authorization", LOGIN_CONTRACT_SCENARIOS[5]!],
  ["deriveRoleFromSubject", "no role derivation from subject", LOGIN_CONTRACT_SCENARIOS[5]!],
  ["cacheAuthorization", "per-request authorization derivation", LOGIN_CONTRACT_SCENARIOS[5]!],
  ["exposeOtherProfile", "profile isolation", LOGIN_CONTRACT_SCENARIOS[5]!],
  ["insecureCookie", "secure cookie attributes", LOGIN_CONTRACT_SCENARIOS[5]!],
  ["skipLogoutInvalidation", "server-side logout", LOGIN_CONTRACT_SCENARIOS[5]!],
];

test("every named security control is load-bearing in the executable corpus", async (context) => {
  for (const [fault, label, expectedScenario] of CONTROL_MUTATIONS) {
    await context.test(label, async () => {
      const report = await runLoginConformance(referenceLoginFactory({ [fault]: true }));
      assert.equal(report.ok, false, `${String(fault)} survived the contract suite`);
      assert.equal(
        report.results.find(({ name }) => name === expectedScenario)?.ok,
        false,
        `${String(fault)} did not reach its named scenario`,
      );
    });
  }
});
