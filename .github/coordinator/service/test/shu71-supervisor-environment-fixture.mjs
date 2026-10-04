// Synthetic configuration only: no command here is executed and no host uid is used.
export const supervisorEnvironment = {
  SHU_SUPERVISOR_SECRET: 's'.repeat(40),
  SHU_WORKER_UID: '995',
  SHU_WORKER_LAUNCH_WRAPPER: '/usr/bin/setpriv --reuid=995 --regid=995 --clear-groups',
  SHU_WORKTREE_ROOT: '/srv/shu/worktrees',
  SHU_PUSH_REMOTE_URL: 'https://github.com/BAWES-Universe/studenthub-platform.git',
  SHU_REVIEW_EVIDENCE_DIR: '/srv/shu/state/review-evidence',
  SHU_REVIEW_EXEC_UID: '994',
  SHU_REVIEW_EXEC_WRAPPER_JSON: '["/usr/local/libexec/shu-review","test"]',
  SHU_REVIEW_MODEL_WRAPPER_JSON: '["/usr/local/libexec/shu-review","model"]',
  SHU_REVIEW_TEST_FILES_JSON: '["tools/fixture/test/scan-vacuous.test.mjs","tools/fixture-2/test/scan-unawaited.test.mjs"]',
};
export const environmentText = (values = supervisorEnvironment) => Object.entries(values).map(([key, value]) => `${key}='${value}'\n`).join('');

export const secretText = () => environmentText({ SHU_SUPERVISOR_SECRET: supervisorEnvironment.SHU_SUPERVISOR_SECRET });
export const coordinatorText = (values = supervisorEnvironment) => environmentText({
  GITHUB_TOKEN: 'GITHUB_POISON', LINEAR_API_TOKEN: 'LINEAR_POISON',
  ...Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'SHU_SUPERVISOR_SECRET')),
});
