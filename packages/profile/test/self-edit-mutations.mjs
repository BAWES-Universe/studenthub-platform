import { spawnSync } from "node:child_process";
// The mutation runner is intentionally file-discovered. Each contract token has
// a focused assertion suite; CI's mutation harness replaces built expressions.
for (const token of ["SHU372_WRITE","SHU372_RULES","SHU372_PAGE","SHU372_OWNER"]) {
  const run=spawnSync(process.execPath,["--test","--test-name-pattern",`^${token} `,"dist/packages/profile/test/self-edit.test.js","dist/apps/gateway/test/profile-edit-http.test.js"],{stdio:"inherit"});
  if(run.status!==0)process.exit(run.status??1);
}
