import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DurableSupervisor,
  listenSupervisor,
  recordSupervisorCompletion,
  signedSupervisorRequest,
  submitIfDispatchEnabled,
  submitToSupervisor,
  supervisorRunOccupiesCapacity,
  verifySupervisorRequest,
} from "../supervisor.mjs";

const SECRET = "test-only-supervisor-secret-is-32-bytes-long";
const SHA = "a".repeat(40);
const ATTEMPT = "11111111-2222-4333-8444-555555555555";

function order(overrides = {}) {
  return {
    version: "1.0.0",
    role: "build",
    runtime: "hermes-pool",
    issue_id: "SHU-67",
    authorization_ref: "SHU-67",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    repo: "BAWES-Universe/studenthub-platform",
    branch: "feat/shu-67-durable-supervisor",
    task_context: "bounded fixture",
    ...overrides,
  };
}

function tempState() {
  return mkdtempSync(join(tmpdir(), "shu67-supervisor-"));
}

function fakeChild(pid = 7001) {
  const child = new EventEmitter();
  child.pid = pid;
  child.processStartToken = `linux-proc-start-${pid}`;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => child.kills.push(signal);
  return child;
}

function supervisor(options = {}) {
  const children = [];
  const schedules = [];
  const instance = new DurableSupervisor({
    stateDir: options.stateDir ?? tempState(),
    secret: SECRET,
    spawnWorker: options.spawnWorker ?? (() => {
      const child = fakeChild(7000 + children.length);
      children.push(child);
      return child;
    }),
    schedule: options.schedule ?? ((fn) => schedules.push(fn)),
    now: options.now ?? (() => "2026-09-08T12:00:00.000Z"),
    probeProcess: options.probeProcess,
    maxOutputBytes: options.maxOutputBytes,
    deadlineMs: options.deadlineMs,
  });
  return { instance, children, schedules };
}

async function drain(schedules) {
  while (schedules.length) await schedules.shift()();
}

test("signed work order binds attempt, repository, branch, and exact head", () => {
  const request = signedSupervisorRequest(order(), SECRET);
  assert.equal(verifySupervisorRequest(request, SECRET).ok, true);
  for (const mutation of [
    { attempt_id: "99999999-2222-4333-8444-555555555555" },
    { repo: "attacker/fork" },
    { branch: "main" },
    { target_sha: "b".repeat(40) },
  ]) {
    const tampered = { ...request, order: { ...request.order, ...mutation } };
    assert.equal(verifySupervisorRequest(tampered, SECRET).ok, false);
  }
});

test("durable acknowledgement returns before worker completion and does not serialize submissions", async () => {
  const { instance, children, schedules } = supervisor();
  const first = await instance.submit(signedSupervisorRequest(order(), SECRET));
  const secondOrder = order({ attempt_id: "22222222-2222-4333-8444-555555555555", issue_id: "SHU-70" });
  const second = await instance.submit(signedSupervisorRequest(secondOrder, SECRET));
  assert.equal(first.stage, "ACCEPTED");
  assert.equal(second.stage, "ACCEPTED");
  assert.equal(first.durable, true);
  assert.equal(children.length, 0, "ack must not wait for spawn or completion");
  assert.equal(schedules.length, 2, "independent attempts are scheduled without a global wait");
  await drain(schedules);
  assert.equal(children.length, 2);
  assert.equal(instance.store.readRun(ATTEMPT).status, "running");
});

test("exact duplicate is idempotent; attempt rebinding is HOLD and never spawns", async () => {
  const { instance, children, schedules } = supervisor();
  const request = signedSupervisorRequest(order(), SECRET);
  assert.equal((await instance.submit(request)).duplicate, false);
  assert.equal((await instance.submit(request)).duplicate, true);
  const rebound = signedSupervisorRequest(order({ branch: "different-branch" }), SECRET);
  const conflict = await instance.submit(rebound);
  assert.equal(conflict.stage, "HOLD");
  assert.match(conflict.reason, /different work order/);
  await drain(schedules);
  assert.equal(children.length, 1, "launch claim must collapse duplicate schedules");
});

test("two concurrent coordinator wakes cannot double-write or double-spawn", async () => {
  const { instance, children, schedules } = supervisor();
  const request = signedSupervisorRequest(order(), SECRET);
  const [one, two] = await Promise.all([instance.submit(request), instance.submit(request)]);
  assert.equal([one.duplicate, two.duplicate].filter(Boolean).length, 1);
  await Promise.all(schedules.splice(0).map((run) => run()));
  assert.equal(children.length, 1);
  assert.equal(instance.store.attempts().length, 1);
});

test("invalid authentication and invalid bindings create no durable attempt", async () => {
  const { instance, children, schedules } = supervisor();
  const request = signedSupervisorRequest(order(), SECRET);
  request.mac = `${request.mac.slice(0, -1)}x`;
  const result = await instance.submit(request);
  assert.equal(result.stage, "HOLD");
  assert.equal(instance.store.attempts().length, 0);
  assert.equal(children.length, 0);
  assert.equal(schedules.length, 0);
  assert.throws(() => signedSupervisorRequest(order({ branch: "bad..branch" }), SECRET), /branch/);
});

test("restart launches a durably accepted order, but an ambiguous launch is never repeated", async () => {
  const stateDir = tempState();
  const first = supervisor({ stateDir });
  await first.instance.submit(signedSupervisorRequest(order(), SECRET));
  assert.equal(first.instance.store.readRun(ATTEMPT).status, "accepted");

  const restarted = supervisor({ stateDir });
  const recovered = restarted.instance.recover();
  assert.equal(recovered[0].status, "accepted");
  await drain(restarted.schedules);
  assert.equal(restarted.children.length, 1, "unlaunched durable work survives daemon restart");

  const afterSpawnRestart = supervisor({ stateDir, probeProcess: () => null });
  const held = afterSpawnRestart.instance.recover();
  assert.equal(held[0].status, "hold");
  assert.equal(held[0].error_code, "LIVENESS_UNKNOWN");
  assert.equal(afterSpawnRestart.children.length, 0, "unknown prior worker must not be duplicated");
});

test("crash across spawn boundary becomes AMBIGUOUS_LAUNCH and cannot double-spawn", async () => {
  const stateDir = tempState();
  const original = supervisor({ stateDir });
  await original.instance.submit(signedSupervisorRequest(order(), SECRET));
  original.instance.store.claimLaunch(ATTEMPT, { phase: "spawn_attempted" });

  const restarted = supervisor({ stateDir });
  const [result] = restarted.instance.recover();
  assert.equal(result.status, "hold");
  assert.equal(result.error_code, "AMBIGUOUS_LAUNCH");
  assert.equal(restarted.schedules.length, 0);
});

test("child completion is durable and remains terminal after restart", async () => {
  const stateDir = tempState();
  const { instance, children, schedules } = supervisor({ stateDir });
  await instance.submit(signedSupervisorRequest(order(), SECRET));
  await drain(schedules);
  children[0].emit("exit", 0, null);
  assert.equal(instance.store.readRun(ATTEMPT).status, "completed");
  const restarted = supervisor({ stateDir });
  assert.equal(restarted.instance.recover()[0].status, "completed");
  assert.equal(restarted.schedules.length, 0);
});

test("worker-owned completion survives daemon failure before its exit event is captured", async () => {
  const stateDir = tempState();
  let completionContract;
  const child = fakeChild();
  const first = supervisor({
    stateDir,
    spawnWorker: (_order, contract) => {
      completionContract = contract;
      return child;
    },
  });
  await first.instance.submit(signedSupervisorRequest(order(), SECRET));
  await drain(first.schedules);
  // Model the worker wrapper persisting its terminal receipt while the daemon
  // is unavailable: no parent exit listener is involved in this write.
  const recorded = recordSupervisorCompletion({ stateDir, completion: {
    attempt_id: completionContract.attempt_id,
    completion_token: completionContract.completion_token,
    target_sha: completionContract.target_sha,
    exit_code: 0,
    signal: null,
    output_bytes: 42,
    finished_at: "2026-09-08T12:01:00.000Z",
  } });
  assert.equal(recorded.ok, true);

  const restarted = supervisor({ stateDir, probeProcess: () => false });
  const [recovered] = restarted.instance.recover();
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.output_bytes, 42);
  assert.equal(restarted.schedules.length, 0);
  assert.equal(restarted.children.length, 0);
});

test("unknown liveness HOLD retains scheduler capacity", async () => {
  const stateDir = tempState();
  const first = supervisor({ stateDir });
  await first.instance.submit(signedSupervisorRequest(order(), SECRET));
  await drain(first.schedules);
  const restarted = supervisor({ stateDir, probeProcess: () => null });
  const [held] = restarted.instance.recover();
  assert.equal(held.error_code, "LIVENESS_UNKNOWN");
  assert.equal(supervisorRunOccupiesCapacity(held), true);
  assert.equal(supervisorRunOccupiesCapacity({ status: "completed" }), false);
  assert.equal(supervisorRunOccupiesCapacity({ status: "failed" }), false);
});

test("forged or stale-head worker completion cannot become terminal", async () => {
  const { instance, schedules } = supervisor();
  let contract;
  instance.spawnWorker = (_order, value) => {
    contract = value;
    return fakeChild();
  };
  await instance.submit(signedSupervisorRequest(order(), SECRET));
  await drain(schedules);
  assert.equal(instance.store.recordCompletion({
    ...contract,
    completion_token: "forged",
    exit_code: 0,
    finished_at: "2026-09-08T12:01:00.000Z",
  }).ok, false);
  assert.equal(instance.store.recordCompletion({
    ...contract,
    target_sha: "b".repeat(40),
    exit_code: 0,
    finished_at: "2026-09-08T12:01:00.000Z",
  }).ok, false);
  assert.equal(instance.store.readRun(ATTEMPT).status, "running");
});

test("forged durable completion file is rejected again during restart recovery", async () => {
  const stateDir = tempState();
  const first = supervisor({ stateDir });
  await first.instance.submit(signedSupervisorRequest(order(), SECRET));
  await drain(first.schedules);
  writeFileSync(first.instance.store.paths(ATTEMPT).completion, JSON.stringify({
    attempt_id: ATTEMPT,
    target_sha: SHA,
    status: "completed",
    exit_code: 0,
    signal: null,
    output_bytes: 0,
    finished_at: "2026-09-08T12:01:00.000Z",
    completion_token: "forged",
  }));
  const restarted = supervisor({ stateDir, probeProcess: () => true });
  const [held] = restarted.instance.recover();
  assert.equal(held.status, "hold");
  assert.equal(held.error_code, "INVALID_COMPLETION");
});

test("a spawned child without real process-start evidence HOLDs and retains capacity", async () => {
  const child = fakeChild();
  delete child.processStartToken;
  const { instance, schedules } = supervisor({ spawnWorker: () => child });
  await instance.submit(signedSupervisorRequest(order(), SECRET));
  await drain(schedules);
  const run = instance.store.readRun(ATTEMPT);
  assert.equal(run.status, "hold");
  assert.equal(run.error_code, "PROCESS_IDENTITY_UNKNOWN");
  assert.equal(supervisorRunOccupiesCapacity(run), true);
});

test("worker output is counted but not retained; cap crossing kills and HOLDs", async () => {
  const { instance, children, schedules } = supervisor({ maxOutputBytes: 5 });
  await instance.submit(signedSupervisorRequest(order(), SECRET));
  await drain(schedules);
  children[0].stdout.emit("data", Buffer.from("123"));
  children[0].stderr.emit("data", Buffer.from("456"));
  const run = instance.store.readRun(ATTEMPT);
  assert.equal(run.status, "hold");
  assert.equal(run.output_bytes, 6);
  assert.equal(run.error_code, "OUTPUT_LIMIT");
  assert.deepEqual(children[0].kills, ["SIGTERM"]);
  assert.equal(JSON.stringify(run).includes("123"), false, "worker output must not enter durable state");
});

test("a worker output-stream error HOLDs without becoming an unhandled daemon error", async () => {
  const { instance, children, schedules } = supervisor();
  await instance.submit(signedSupervisorRequest(order(), SECRET));
  await drain(schedules);
  children[0].stdout.emit("error", new Error("broken pipe"));
  const run = instance.store.readRun(ATTEMPT);
  assert.equal(run.status, "hold");
  assert.equal(run.error_code, "OUTPUT_STREAM_ERROR");
});

test("deadline kills and HOLDs an incomplete worker", async () => {
  const { instance, children, schedules } = supervisor({ deadlineMs: 5 });
  await instance.submit(signedSupervisorRequest(order(), SECRET));
  await drain(schedules);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(instance.store.readRun(ATTEMPT).error_code, "DEADLINE");
  assert.deepEqual(children[0].kills, ["SIGTERM"]);
});

test("Unix socket is forced owner-only before it is returned as ready", async () => {
  const root = tempState();
  const socketPath = join(root, "run", "supervisor.sock");
  const { instance } = supervisor({ stateDir: join(root, "state") });
  const fakeServer = new EventEmitter();
  fakeServer.listen = (path, callback) => {
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700, "parent must be private before socket bind");
    writeFileSync(path, "socket fixture", { mode: 0o666 });
    callback();
  };
  fakeServer.close = () => {};
  await listenSupervisor({ supervisor: instance, socketPath, serverFactory: () => fakeServer });
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
});

test("one broken IPC client cannot crash the supervisor server", async () => {
  const root = tempState();
  const socketPath = join(root, "run", "supervisor.sock");
  const { instance } = supervisor({ stateDir: join(root, "state") });
  let accept;
  const fakeServer = new EventEmitter();
  fakeServer.listen = (path, callback) => {
    writeFileSync(path, "socket fixture", { mode: 0o600 });
    callback();
  };
  fakeServer.close = () => {};
  await listenSupervisor({
    supervisor: instance,
    socketPath,
    serverFactory: (handler) => {
      accept = handler;
      return fakeServer;
    },
  });
  const brokenClient = new EventEmitter();
  brokenClient.setEncoding = () => {};
  brokenClient.end = () => {};
  accept(brokenClient);
  assert.doesNotThrow(() => brokenClient.emit("error", new Error("reset")));
});

test("Unix socket round trip accepts durable work where the host permits sockets", async (t) => {
  const root = tempState();
  const socketPath = join(root, "run", "supervisor.sock");
  const { instance } = supervisor({ stateDir: join(root, "state") });
  let server;
  try {
    server = await listenSupervisor({ supervisor: instance, socketPath });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("runtime forbids Unix-domain sockets");
      return;
    }
    throw error;
  }
  t.after(() => server.close());
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  const accepted = await submitToSupervisor({ socketPath, request: signedSupervisorRequest(order(), SECRET) });
  assert.equal(accepted.stage, "ACCEPTED");
  assert.equal(accepted.durable, true);
});

test("unavailable daemon returns HOLD with no direct-spawn fallback", async () => {
  const root = tempState();
  const missing = await submitToSupervisor({
    socketPath: join(root, "missing.sock"),
    request: signedSupervisorRequest(order(), SECRET),
    timeoutMs: 20,
  });
  assert.equal(missing.stage, "HOLD");
  assert.match(missing.reason, /direct spawn is forbidden/);
});

test("dispatch-disabled gate performs no transport, durable write, or launch side effect", async () => {
  let contacts = 0;
  const result = await submitIfDispatchEnabled({
    dispatchEnabled: false,
    transport: async () => {
      contacts += 1;
      throw new Error("must not contact daemon");
    },
    socketPath: "/not-used",
    request: signedSupervisorRequest(order(), SECRET),
  });
  assert.equal(result.stage, "DISABLED");
  assert.equal(contacts, 0);
});

test("shutdown retains children by default; explicit termination HOLDs and signals them", async () => {
  const keep = supervisor();
  await keep.instance.submit(signedSupervisorRequest(order(), SECRET));
  await drain(keep.schedules);
  keep.instance.shutdown();
  assert.deepEqual(keep.children[0].kills, []);
  assert.equal(keep.instance.store.readRun(ATTEMPT).status, "running");

  keep.instance.shutdown({ terminateChildren: true });
  assert.deepEqual(keep.children[0].kills, ["SIGTERM"]);
  assert.equal(keep.instance.store.readRun(ATTEMPT).error_code, "SUPERVISOR_SHUTDOWN");
  keep.children[0].emit("exit", null, "SIGTERM");
  assert.equal(keep.instance.store.readRun(ATTEMPT).error_code, "SUPERVISOR_SHUTDOWN", "exit cannot overwrite shutdown HOLD");
});
