import { applyAdapterLaunchEnvironment, readAdapterLaunchEnvironment } from "./service/units.mjs";
import { supervisorChildEnvironment } from "./service/credential-delivery.mjs";
// Adapter execution runs in a separate process owned by the supervisor. Service
// installation and credential delivery belong to SHU-251.
import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordSupervisorCompletion, SUPERVISOR_PROTOCOL_VERSION, CHILD_FAILURE_CODES } from "./supervisor.mjs";

// Authorization is host policy, not a claim in the work order. The service must
// supply a child-side module that rechecks the activation before launch and each
// publication. It must return true explicitly; absence/failure denies execution.
export function createSupervisorSpawner({ stateDir, authorizationModule = fileURLToPath(new URL("./supervisor-authorization.mjs", import.meta.url)), env = process.env, forkImpl = fork }) {
  if (!authorizationModule?.startsWith("/")) throw new Error("absolute host authorization module required");
  return (order, contract) => {
    const child = forkImpl(fileURLToPath(import.meta.url), [], { env: supervisorChildEnvironment(env),
      stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true });
    try {
      const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
      child.processStartToken = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    } catch { child.processStartToken = null; }
    // Kill the process group, including the adapter's worker, on a deadline.
    child.kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
    child.send({ order, contract, stateDir, authorizationModule });
    return child;
  };
}

// Velocity B: why a worker exited without a result, as a fixed code only (never
// error text, which may carry credentials). The supervisor carries the code
// into the run's error_code, so the receipt names the cause.
function childFailure(error, code) {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (!failure.childCode) failure.childCode = code;
  return failure;
}
export function childFailureCode(error) {
  const custody = /SHU251_ENV_CUSTODY|SHU251_ENV_CROSSED|SHU71_SUPERVISOR_ENV_REQUIRED/.exec(String(error?.message ?? ""))?.[0];
  if (custody) return custody;
  return CHILD_FAILURE_CODES.includes(error?.childCode) ? error.childCode : "SHU251_CHILD_FAILED";
}

export async function executeSupervisedOrder({ order, contract, stateDir, authorizationModule }, { env = process.env, send = () => {}, loadAdapter = name => import(`./adapters/${name}.mjs`) } = {}) {
  const policy = await import(authorizationModule);
  // A policy that names its denial (supervisor-authorization.mjs) hands the name
  // to the push broker, which puts it on the held result; a plain boolean policy
  // still decides alone.
  const authorized = () => {
    if (typeof policy.workOrderAuthorization !== "function") return policy.authorizeWorkOrder(order) === true;
    const verdict = policy.workOrderAuthorization(order);
    return verdict?.ok === true ? true : { code: verdict?.code ?? null };
  };
  const launch = authorized();
  if (launch !== true) throw Object.assign(new Error(`host authorization refused supervised order${launch?.code ? ` (${launch.code})` : ""}`), { childCode: "CHILD_AUTH_REFUSED" });
  const adapters = { "codex-cli": "codex-cli", "claude-code": "claude-code", "hermes-pool": "hermes-pool", "workspace-agents": "workspace-agents" };
  const name = adapters[order.runtime];
  if (!name) throw Object.assign(new Error("unsupported supervised runtime"), { childCode: "CHILD_RUNTIME_UNSUPPORTED" });
  const adapter = await loadAdapter(name);
  const options = { ...order, env, oauth_token: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    token: env.WORKSPACE_AGENT_ACCESS_TOKEN ?? "", api_trigger_id: env.WORKSPACE_AGENT_TRIGGER_ID ?? "",
    io: { resultStillAuthorized: authorized } };
  const beat = () => send({ version: SUPERVISOR_PROTOCOL_VERSION, type: "heartbeat",
    attempt_id: order.attempt_id, target_sha: order.target_sha, at: new Date().toISOString() });
  beat();
  const timer = setInterval(beat, 10_000);
  try {
    let result;
    try { result = await adapter.launchBuilder(options); } catch (error) { throw childFailure(error, "CHILD_ADAPTER_LAUNCH_THREW"); }
    const runId = result.external_run_id;
    while (["RUNNING", "UNCHANGED"].includes(result.stage)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try { result = await adapter.monitorRun({ ...options, run_id: runId }); } catch (error) { throw childFailure(error, "CHILD_ADAPTER_MONITOR_THREW"); }
    }
    // Copy the adapter's own callback verbatim; never reconstruct evidence from
    // an exit code, work order, session id or a supervisor heartbeat.
    const recorded = recordSupervisorCompletion({ stateDir, completion: {
      ...contract, version: SUPERVISOR_PROTOCOL_VERSION, result,
      exit_code: result.stage === "COMPLETED" ? 0 : 1, signal: null,
      finished_at: new Date().toISOString(),
    } });
    if (!recorded.ok) throw Object.assign(new Error(recorded.reason), { childCode: "CHILD_COMPLETION_UNRECORDED" });
    return result;
  } finally { clearInterval(timer); }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.send) {
  process.once("message", async message => {
    try {
      if (process.env.SHU71_EVIDENCE_BROKER === 'true') {
        applyAdapterLaunchEnvironment(process.env, readAdapterLaunchEnvironment());
      }
      await executeSupervisedOrder(message, { send: value => { if (process.connected) process.send(value); } }); process.exit(0); }
    catch (error) {
      process.stderr.write(`${childFailureCode(error)}\n`); process.exit(1);
    }
  });
}
