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
  assert.match(workflow, /deploy:\n(?:    #.*\n)*    if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' \}\}\n    needs: env-manifest/,
    "MANUAL_DEPLOY_ONLY: deployment must require main dispatch and the environment gate");
  const deploy = workflow.slice(workflow.indexOf("\n  deploy:"));
  assert.doesNotMatch(deploy, /github\.event_name == 'push'/,
    "NO_MERGE_DEPLOY: push must never authorize deployment");
  const recorded = deploy.indexOf('path: selected-artifact.json');
  assert.ok(recorded >= 0 && recorded < deploy.indexOf('run: node deploy/coolify/trigger-selected.mjs'),
    "RECORD_BEFORE_TRIGGER: selection upload must precede deployment");
  assert.doesNotMatch(workflow, /DEPLOYMENT_ENV_MANIFEST_PATH:/);
  assert.match(workflow, /Validate proposed manifest as untrusted data/);
  assert.match(workflow, /Verify trusted Coolify deployment environment/);
});

const probeOptions = {
  baseUrl: "https://coolify.example.test",
  token: "test-read-token",
  applicationUuid: "gateway-uuid",
};

for (const code of ["EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "TimeoutError"]) {
  test(`env read recovers from ${code} with bounded backoff and fresh timeouts`, async () => {
    const signals = [];
    const waits = [];
    const logs = [];
    const result = await checkCoolifyEnv({
      ...probeOptions,
      sleep: async (ms) => waits.push(ms),
      stderr: { write: (line) => logs.push(line) },
      fetchImplementation: async (_url, options) => {
        signals.push(options.signal);
        if (signals.length < 3) {
          if (code === "TimeoutError") throw new DOMException("private details", code);
          throw new TypeError("private details", { cause: { code } });
        }
        return response(requiredEntries);
      },
    });
    assert.equal(result.checked, 11);
    assert.deepEqual(waits, [1000, 2000]);
    assert.equal(new Set(signals).size, 3);
    assert.equal(logs.length, 2);
    assert.ok(logs.every((line) => line.includes(code)));
    assert.doesNotMatch(logs.join(""), /private details|test-read-token/);
  });
}

test("env read exhausts three attempts and fails without exposing exception data", async () => {
  let calls = 0;
  const logs = [];
  await assert.rejects(checkCoolifyEnv({
    ...probeOptions,
    sleep: async () => {},
    stderr: { write: (line) => logs.push(line) },
    fetchImplementation: async () => {
      calls += 1;
      throw new TypeError("private details", { cause: { code: "ECONNRESET", message: "private details" } });
    },
  }), { message: "Coolify deployment environment check could not read application gateway-uuid (ECONNRESET; attempt 3/3)" });
  assert.equal(calls, 3);
  assert.equal(logs.length, 2);
  assert.doesNotMatch(logs.join(""), /private details/);
});

for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "private-details"]) {
  test(`env read keeps ${code} terminal and only logs allowlisted labels`, async () => {
    let calls = 0;
    const label = code === "private-details" ? "UNCLASSIFIED_FETCH_ERROR" : code;
    await assert.rejects(checkCoolifyEnv({
      ...probeOptions,
      sleep: async () => assert.fail("must not retry"),
      fetchImplementation: async () => {
        calls += 1;
        throw new TypeError("private details", { cause: { code } });
      },
    }), { message: `Coolify deployment environment check could not read application gateway-uuid (${label}; attempt 1/3)` });
    assert.equal(calls, 1);
  });
}

for (const key of DEPLOYMENT_ENV_MANIFEST.required) {
  test(`env read recovery still fails closed for missing ${key}`, async () => {
    let calls = 0;
    await assert.rejects(checkCoolifyEnv({
      ...probeOptions,
      sleep: async () => {},
      stderr: { write() {} },
      fetchImplementation: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error(), { code: "ECONNRESET" });
        return response(requiredEntries.filter((entry) => entry.key !== key));
      },
    }), { message: failureMessage({ application: "studenthub-gateway", applicationUuid: "gateway-uuid", missing: [key] }) });
    assert.equal(calls, 2, "missing runtime keys must fail immediately after a successful read");
  });
}

for (const status of [401, 403, 404, 429, 500, 503]) {
  test(`env read HTTP ${status} remains fail-closed without parsing the response`, async () => {
    await assert.rejects(checkCoolifyEnv({
      ...probeOptions,
      sleep: async () => assert.fail("must not retry"),
      fetchImplementation: async () => ({ ok: false, status, json() { assert.fail("must not read response body"); } }),
    }), new RegExp(`HTTP ${status}`));
  });
}

for (const malformed of [null, {}, "private details"]) {
  test(`env read rejects malformed environment lists (${typeof malformed})`, async () => {
    await assert.rejects(checkCoolifyEnv({
      ...probeOptions,
      fetchImplementation: async () => response(malformed),
    }), /invalid environment-variable list/);
  });
}

test("env read rejects invalid JSON", async () => {
  await assert.rejects(checkCoolifyEnv({
    ...probeOptions,
    fetchImplementation: async () => ({ ok: true, async json() { throw new Error("private details"); } }),
  }), { message: "Coolify deployment environment check received invalid JSON for application gateway-uuid" });
});

for (const name of ["COOLIFY_BASE", "COOLIFY_READ_TOKEN", "COOLIFY_STUDENTHUB_GATEWAY_UUID"]) {
  test(`env check rejects absent ${name} before any request`, async () => {
    const env = { COOLIFY_BASE: probeOptions.baseUrl, COOLIFY_READ_TOKEN: probeOptions.token, COOLIFY_STUDENTHUB_GATEWAY_UUID: probeOptions.applicationUuid };
    delete env[name];
    await assert.rejects(runFromEnv({
      env,
      fetchImplementation: async () => assert.fail("must not contact Coolify"),
    }), { message: `deployment environment check configuration is missing ${name}` });
  });
}
