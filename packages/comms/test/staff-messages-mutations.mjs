import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Each mutant breaks one staff-message rule; the named suite token must fail.
const mutations=[
 ['staff gate','if (!(await this.authority.isStaff(senderPrincipalId)))','if (!(await this.authority.isStaff("staff-1")))','COMMS_STAFF_MSG_AUTH','packages/comms/test/staff-messages.test.js','packages/comms/src/staff-messages.js'],
 ['body limit','[...body].length > STAFF_MESSAGE_BODY_MAX','[...body].length > STAFF_MESSAGE_BODY_MAX + 1','COMMS_STAFF_MSG_VALIDATE','packages/comms/test/staff-messages.test.js','packages/comms/src/staff-messages.js'],
 ['types filter is closed','if (values.some(v => !this.#byKind.has(v)))','if (false)','COMMS_FEED_TYPES','packages/notifications/test/notifications.test.js','packages/notifications/src/notifications.js'],
 ['registry checks payloads','&& d.parameters(row.parameters)','&& true','COMMS_FEED_REGISTRY','packages/notifications/test/notifications.test.js','packages/notifications/src/notifications.js'],
 ['send route staff gate','if (!staff) {','if (false) {','COMMS_STAFF_SEND_HTTP','apps/gateway/test/staff-messages-http.test.js','apps/gateway/src/comms/staff-messages-http.js'],
 ['civil ID result is transactional','"civil_id.result": { required: true','"civil_id.result": { required: false','COMMS_EMAIL_CIVIL_ID_RESULT','packages/notifications/test/email-classes.test.js','packages/notifications/src/email-templates.js'],
 ['volume levels step past each multiple','Math.floor((sentCount - 1) / threshold)','Math.floor(sentCount / threshold)','COMMS_EMAIL_VOLUME','packages/notifications/test/email-classes.test.js','packages/notifications/src/email-volume.js'],
 ['a failed run keeps its own error','throw failed ? failure : error','throw error','COMMS_EMAIL_VOLUME','packages/notifications/test/email-classes.test.js','packages/notifications/src/email-volume.js'],
 ['delivery log page is bounded','^[1-9][0-9]{0,5}$','^[0-9]{1,7}$','COMMS_EMAIL_DELIVERY_LOG_HTTP','apps/gateway/test/staff-messages-http.test.js','apps/gateway/src/comms/staff-messages-http.js'],
 ['feed renders the stored body','renderStaffMessage(message.kind, message.body)','renderStaffMessage(message.kind, null)','COMMS_FEED_STAFF','packages/notifications/test/notifications.test.js','packages/notifications/src/notifications.js'],
];
const root=new URL('../../../',import.meta.url);
for(const[name,from,to,token,suite,file]of mutations){
 const dir=await mkdtemp(new URL('./node_modules/.comms-mutation-',root).pathname);
 try{
  await cp(new URL('./dist/',root),dir,{recursive:true});
  await writeFile(join(dir,'package.json'),'{"type":"module"}');
  const copiedSuite=join(dir,suite),suiteSource=await readFile(copiedSuite,'utf8');
  await writeFile(copiedSuite,suiteSource.replace('from "@studenthub/db"','from "../../db/src/index.js"'));
  const target=join(dir,file),source=await readFile(target,'utf8');
  assert.equal(source.split(from).length-1,1,`${name} binds once`);
  await writeFile(target,source.replace(from,to));
  const run=spawnSync(process.execPath,['--test',suite],{cwd:dir,encoding:'utf8',timeout:20000});
  assert.equal(run.error,undefined,`${name}: ${run.error}`);
  assert.notEqual(run.status,0,`${name} survived`);
  assert.match(run.stdout+run.stderr,new RegExp(`not ok \\d+ - ${token}`));
 }finally{await rm(dir,{recursive:true,force:true})}
}
process.stdout.write(`${mutations.length}/${mutations.length} comms mutations killed\n`);
