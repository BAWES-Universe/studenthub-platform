import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkCoolifyEnv,
  failureMessage,
  missingRequiredEnv,
  runFromEnv,
} from "../check-env-manifest.mjs";
import { DEPLOYMENT_ENV_MANIFEST, REQUIRED_COOLIFY_ENV } from "../deployment-env-manifest.mjs";
import { REQUIRED_DEPLOYMENT_ENV } from "../preflight.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const requiredEntries = DEPLOYMENT_ENV_MANIFEST.required.map((key) => ({
  key,
  value: `value-for-${key}`,
  real_value: `real-value-for-${key}`,
  is_preview: false,
}));

function response(entries, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return entries; } };
}

test("SHU-243 manifest derives every runtime requirement and semantic input", () => {
  assert.deepEqual(
    DEPLOYMENT_ENV_MANIFEST.required,
    ["HOST", ...REQUIRED_DEPLOYMENT_ENV, "PLATFORM_DATABASE_HOSTS"],
  );
  assert.deepEqual(REQUIRED_COOLIFY_ENV, DEPLOYMENT_ENV_MANIFEST.required);
  assert.equal(new Set(DEPLOYMENT_ENV_MANIFEST.required).size, DEPLOYMENT_ENV_MANIFEST.required.length);
});

test("SHU-243 missing key fails with an actionable application-scoped message", async () => {
  const entries = requiredEntries.filter(({ key }) => key !== "OIDC_CLIENT_SECRET");
  await assert.rejects(
    () => checkCoolifyEnv({
      baseUrl: "https://coolify.example.test/",
      token: "token-secret",
      applicationUuid: "gateway-uuid",
      fetchImplementation: async () => response(entries),
    }),
    (error) => {
      assert.equal(error.message, failureMessage({
        application: "studenthub-gateway",
        applicationUuid: "gateway-uuid",
        missing: ["OIDC_CLIENT_SECRET"],
      }));
      assert.match(error.message, /Set OIDC_CLIENT_SECRET on Coolify application gateway-uuid/);
      return true;
    },
  );
});

test("SHU-243 redacted values still satisfy the key-presence check", () => {
  const entries = requiredEntries.map((entry) => entry.key === "PLATFORM_DATABASE_HOSTS"
    ? { ...entry, value: null, real_value: null }
    : entry);
  assert.deepEqual(missingRequiredEnv(entries), []);
});

test("SHU-243 key-presence check never reads sensitive value fields", () => {
  const entries = requiredEntries.map(({ value: _value, real_value: _realValue, ...entry }) =>
    Object.defineProperties(entry, {
      value: { get() { throw new Error("value must remain unread"); } },
      real_value: { get() { throw new Error("real_value must remain unread"); } },
    }));
  assert.deepEqual(missingRequiredEnv(entries), []);
});

test("SHU-243 preview-only or build-only keys do not satisfy the runtime manifest", () => {
  const entries = requiredEntries.map((entry) => entry.key === "HOST"
    ? { ...entry, is_preview: true }
    : entry.key === "DATABASE_URL" ? { ...entry, is_runtime: false } : entry);
  assert.deepEqual(missingRequiredEnv(entries), ["HOST", "DATABASE_URL"]);
});

test("SHU-243 present keys pass and use the read-only Coolify endpoint", async () => {
  let request;
  const result = await checkCoolifyEnv({
    baseUrl: "https://coolify.example.test/",
    token: "read-token",
    applicationUuid: "gateway/uuid",
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return response(requiredEntries);
    },
  });
  assert.deepEqual(result, {
    application: "studenthub-gateway",
    applicationUuid: "gateway/uuid",
    checked: DEPLOYMENT_ENV_MANIFEST.required.length,
  });
  assert.equal(request.url, "https://coolify.example.test/api/v1/applications/gateway%2Fuuid/envs");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.redirect, "error");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(request.options.headers).sort(), ["Accept", "Authorization"]);
});

test("SHU-243 output never leaks values or token material", async () => {
  const token = "token-material-must-not-leak";
  const value = "environment-value-must-not-leak";
  const output = [];
  await runFromEnv({
    env: {
      COOLIFY_BASE: "https://coolify.example.test",
      COOLIFY_READ_TOKEN: token,
      COOLIFY_STUDENTHUB_GATEWAY_UUID: "gateway-uuid",
    },
    fetchImplementation: async () => response(requiredEntries.map((entry) => ({
      ...entry,
      value,
      real_value: value,
    }))),
    stdout: { write(chunk) { output.push(chunk); } },
  });
  const rendered = output.join("");
  assert.doesNotMatch(rendered, new RegExp(token));
  assert.doesNotMatch(rendered, new RegExp(value));

  const apiFailure = await checkCoolifyEnv({
    baseUrl: "https://coolify.example.test",
    token,
    applicationUuid: "gateway-uuid",
    fetchImplementation: async () => ({
      ok: false,
      status: 401,
      async json() { return { message: `${token} ${value}` }; },
    }),
  }).then(() => "unexpected success", (error) => error.message);
  assert.doesNotMatch(apiFailure, new RegExp(token));
  assert.doesNotMatch(apiFailure, new RegExp(value));
});

test("SHU-243 fork manifest cannot choose keys for the credential-bearing probe", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "shu243-untrusted-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const attackerManifest = join(root, "deployment-env-manifest.json");
  writeFileSync(attackerManifest, JSON.stringify({
    schemaVersion: 1,
    application: "studenthub-gateway",
    required: ["ATTACKER_GUESS"],
  }));
  const output = [];
  const result = await runFromEnv({
    env: {
      COOLIFY_BASE: "https://coolify.example.test",
      COOLIFY_READ_TOKEN: "read-token",
      COOLIFY_STUDENTHUB_GATEWAY_UUID: "gateway-uuid",
      DEPLOYMENT_ENV_MANIFEST_PATH: attackerManifest,
    },
    fetchImplementation: async () => response(requiredEntries),
    stdout: { write(chunk) { output.push(chunk); } },
  });
  assert.equal(result.checked, DEPLOYMENT_ENV_MANIFEST.required.length);
  assert.doesNotMatch(output.join(""), /ATTACKER_GUESS/);
});

test("SHU-243 workflow gates image build and push on the env-store check", () => {
  const workflow = readFileSync(`${repositoryRoot}/.github/workflows/build.yml`, "utf8");
  const check = workflow.indexOf("node deploy/coolify/check-env-manifest.mjs");
  const build = workflow.indexOf("uses: docker/build-push-action@v7");
  assert.notEqual(check, -1);
  assert.ok(check < build, "env-store check must execute before image build/push");
  assert.match(workflow, /COOLIFY_BASE: \$\{\{ secrets\.COOLIFY_BASE \}\}/);
  assert.match(workflow, /COOLIFY_READ_TOKEN: \$\{\{ secrets\.COOLIFY_READ_TOKEN \}\}/);
  assert.match(workflow, /COOLIFY_STUDENTHUB_GATEWAY_UUID: \$\{\{ secrets\.COOLIFY_STUDENTHUB_GATEWAY_UUID \}\}/);
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(workflow, /application\/vnd\.github\.raw\+json/);
  assert.match(workflow, /if: \$\{\{ github\.event_name != 'pull_request_target' \}\}/);
  assert.match(workflow, /build-push:\n    if:.*\n    needs: env-manifest/);
  assert.match(workflow, /deploy:\n    if: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/);
  assert.doesNotMatch(workflow, /DEPLOYMENT_ENV_MANIFEST_PATH:/);
  assert.match(workflow, /Validate proposed manifest as untrusted data/);
  assert.match(workflow, /Verify trusted Coolify deployment environment/);
});
