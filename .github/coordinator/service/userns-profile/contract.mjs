// Repository-only design validator. No host IO, command execution or deployment API.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const RUNNER = '/usr/local/libexec/shu251-a12-suite-runner';
export const CHECKOUT = '/srv/shu251/a12-disposable/checkout';
export const PROFILE = 'shu251-a12-runner';
export const CHILD = `${PROFILE}//probe`;
export const PROBE = ['/usr/bin/unshare', '--user', '--map-root-user', '/bin/true'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function requireThat(ok, code) {
  if (!ok) throw Object.assign(new Error(code), { code });
}
const equal = (a, b, code) => requireThat(isDeepStrictEqual(a, b), code);
export function candidate(profileText) {
  return {
    version: 1, profileText, launcher: [RUNNER], probe: [...PROBE],
    identity: { uid: 999, gid: 982, groups: [980] },
    checkout: CHECKOUT, transition: { mode: 'Cx', target: CHILD, fallback: false },
    names: [PROFILE, CHILD], ordinary: { node: 'unchanged', coordinator: 'unchanged', supervisor: 'unchanged' },
    sysctlWrites: [], sudoChanges: [],
  };
}
export function validateDesign(d, reviewedText) {
  requireThat(typeof d?.profileText === 'string', 'A12_PROFILE_BYTES');
  requireThat(d.profileText.includes('    userns create,\n'), 'A12_USERNS_REQUIRED');
  equal(d.names, [PROFILE, CHILD], 'A12_PROFILE_NAME_REQUIRED');
  requireThat(d.profileText.includes(`profile ${PROFILE} `) && d.profileText.includes('  profile probe flags=(enforce) {'), 'A12_PROFILE_NAME_REQUIRED');
  requireThat(d.profileText.includes(`profile ${PROFILE} ${RUNNER} flags=(enforce) {`), 'A12_EXECUTABLE_REQUIRED');
  equal(d.transition, { mode: 'Cx', target: CHILD, fallback: false }, 'A12_TRANSITION_REQUIRED');
  requireThat(d.profileText.includes('  /usr/bin/unshare rCx -> probe,\n'), 'A12_TRANSITION_REQUIRED');
  equal(d.launcher, [RUNNER], 'A12_PATH_SCOPE_REQUIRED');
  equal(d.probe, PROBE, 'A12_PATH_SCOPE_REQUIRED');
  equal(d.checkout, CHECKOUT, 'A12_PATH_SCOPE_REQUIRED');
  requireThat(!d.profileText.includes('/**') && !d.profileText.includes('/usr/bin/*'), 'A12_PATH_SCOPE_REQUIRED');
  equal(d.sysctlWrites, [], 'A12_NO_SYSCTL_RELAXATION');
  equal(d.ordinary, { node: 'unchanged', coordinator: 'unchanged', supervisor: 'unchanged' }, 'A12_ORDINARY_EXCLUDED');
  equal(d.identity, { uid: 999, gid: 982, groups: [980] }, 'A12_FIXED_IDENTITY');
  equal(d.sudoChanges, [], 'A12_NO_SUDO_AUTHORITY');
  equal(d.profileText, reviewedText, 'A12_PROFILE_BYTES');
  equal(d, candidate(reviewedText), 'A12_CLOSED_SCHEMA');
  return sha256(canonical(d));
}
// All values here describe required evidence, not observed platform properties.
export const REQUIRED_PLATFORM = Object.freeze({
  dedicatedStaticElf: true, exactAttachment: true, childCx: true,
  usernsCreate: true, enforce: true, noSharedInterpreterWidening: true,
  pinnedRuntimeClosure: true, authenticatedEvidence: true,
});
export function platformGate(evidence) {
  equal(evidence, REQUIRED_PLATFORM, 'A12_DESIGN_BLOCKER');
}
// Model a serialized, exclusive lifecycle. Facts must come from an independent,
// authorized verifier in a future implementation, never from the runner itself.
export function lifecycle(design, reviewedText, platform, pins) {
  const designDigest = validateDesign(design, reviewedText);
  platformGate(platform);
  requireThat(pins && Object.keys(pins).sort().join(',') === 'checkout,parser,runner,runtime' &&
    Object.values(pins).every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)), 'A12_PINS_REQUIRED');
  const pinned = structuredClone(pins);
  let phase = 'absent', previous = null;
  const required = {
    install: { beforeNames: [], loadedNames: [PROFILE, CHILD], mode: 'enforce',
      parserDigest: pinned.parser, profileDigest: sha256(reviewedText), attachment: RUNNER,
      runnerDigest: pinned.runner, runtimeDigest: pinned.runtime, exclusive: true },
    verify: { loadedNames: [PROFILE, CHILD], mode: 'enforce', parserDigest: pinned.parser,
      profileDigest: sha256(reviewedText), runnerDigest: pinned.runner, runtimeDigest: pinned.runtime,
      checkoutDigest: pinned.checkout, checkout: CHECKOUT, disposable: true,
      identity: { uid: 999, gid: 982, groups: [980] }, argv: [...PROBE],
      beforeLabel: `${PROFILE} (enforce)`, afterLabel: `${CHILD} (enforce)`,
      nodeLabelChanged: false, coordinatorLabelChanged: false, supervisorLabelChanged: false,
      initialCapabilities: [], fileCapabilities: [], setid: false, environment: { LC_ALL: 'C' },
      sysctlChanged: false, sudoChanged: false, extraAuthority: [], authenticated: true },
    teardown: { loadedNames: [], attachedTasks: [], policyFilePresent: false,
      runnerPresent: false, checkoutPresent: false, cachePresent: false, sysctlChanged: false,
      sudoChanged: false, baselineRestored: true },
  };
  return {
    // A copy for fake tests/specification consumers; this is NOT evidence collection.
    requiredFacts: action => structuredClone(required[action]),
    accept(action, facts) {
      requireThat(({ absent: ['install'], installed: ['verify', 'teardown'], verified: ['teardown'], failed: ['teardown'] })[phase]?.includes(action), 'A12_RECEIPT_ORDER');
      try {
        if (action === 'teardown') requireThat(Array.isArray(facts?.loadedNames) && facts.loadedNames.length === 0 &&
          Array.isArray(facts?.attachedTasks) && facts.attachedTasks.length === 0 && facts.policyFilePresent === false &&
          facts.runnerPresent === false && facts.cachePresent === false, 'A12_TEARDOWN_NO_RESIDUE');
        if (action === 'verify') {
          equal(facts?.afterLabel, `${CHILD} (enforce)`, 'A12_TRANSITION_REQUIRED');
          requireThat(facts.nodeLabelChanged === false && facts.coordinatorLabelChanged === false &&
            facts.supervisorLabelChanged === false, 'A12_ORDINARY_EXCLUDED');
        }
        equal(facts, required[action], `A12_${action.toUpperCase()}_EVIDENCE`);
      } catch (error) { phase = 'failed'; throw error; }
      const body = { version: 1, kind: 'design-simulation', action, designDigest, pins: pinned, previous, facts: structuredClone(facts) };
      const receipt = { ...body, digest: sha256(canonical(body)) };
      previous = receipt.digest;
      phase = ({ install: 'installed', verify: 'verified', teardown: 'removed' })[action];
      return structuredClone(receipt);
    },
  };
}
