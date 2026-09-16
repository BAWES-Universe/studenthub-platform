// Syntax-clean data/policy mutations, deliberately separate from the validator.
export const controls = [
  ['missing-userns', 'A12_USERNS_REQUIRED', d => { d.profileText = d.profileText.replace('    userns create,\n', ''); }],
  ['wrong-executable', 'A12_EXECUTABLE_REQUIRED', d => { d.profileText = d.profileText.replace(' /usr/local/libexec/shu251-a12-suite-runner flags=', ' /usr/bin/node flags='); }],
  ['bypassed-transition', 'A12_TRANSITION_REQUIRED', d => { d.profileText = d.profileText.replace('rCx -> probe', 'rix'); }],
  ['profile-name-substitution', 'A12_PROFILE_NAME_REQUIRED', d => { d.profileText = d.profileText.replace('profile probe flags=', 'profile substituted flags='); }],
  ['widened-path', 'A12_PATH_SCOPE_REQUIRED', d => { d.profileText = d.profileText.replace('/usr/bin/unshare mr,', '/usr/bin/** mr,'); }],
  ['global-sysctl-relaxation', 'A12_NO_SYSCTL_RELAXATION', d => { d.sysctlWrites.push({ key: 'kernel.apparmor_restrict_unprivileged_userns', value: 0 }); }],
  ['ordinary-execution-exception', 'A12_ORDINARY_EXCLUDED', (d, facts) => { facts.verify.coordinatorLabelChanged = true; facts.verify.supervisorLabelChanged = true; }],
  ['teardown-residue', 'A12_TEARDOWN_NO_RESIDUE', (d, facts) => { facts.teardown.loadedNames = ['shu251-a12-runner//probe']; }],
];
