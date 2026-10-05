// Preload for a child that runs the REAL production CLI entry point.
//
// Two doubles, both stated here rather than hidden in the control: the identity
// guard is answered as root, exactly as productionFixture answers `uid: () => 0`
// for every other control in this suite; and `node:child_process` is resolved to
// a recording module FOR THE MODULE UNDER TEST ONLY, so the one spawnSync the
// CLI performs is captured instead of executed. The module's own source, its
// argv construction and its `process.env.INVOCATION_ID` read are untouched.
import { registerHooks } from 'node:module';
const recorder = new URL('./shu71-reexec-spawn-recorder.mjs', import.meta.url).href;
const target = process.env.SHU71_REEXEC_TARGET;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process' && context.parentURL === target) return { url: recorder, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
process.getuid = () => 0;
