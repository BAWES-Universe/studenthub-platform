import{spawnSync}from"node:child_process";import{readFileSync,writeFileSync,rmSync}from"node:fs";import{dirname,join}from"node:path";
const source="dist/packages/notifications/src/email-outbox.js",test="dist/packages/notifications/test/email-outbox.test.js",original=readFileSync(source,"utf8");
const run=module=>spawnSync(process.execPath,["--test",test],{encoding:"utf8",env:{...process.env,...(module?{SHU440_TEST_MODULE:module}:{})}});
const clean=run();if(clean.status!==0)throw Error(clean.stdout+clean.stderr);
for(const[token,from,to]of[
 ["SHU189_ENQUEUE","validateTemplateParameters(messageClass, parameters);","throw new TypeError('mutant');"],
 ["SHU189_DELIVERY","return await store.deliverBatch(port, production);","return -1;"],
 ["SHU189_NO_SENDS","store.deliverBatch(port, production)","store.deliverBatch(port, true)"],
 ["SHU189_PRIVACY",'throw new Error("email delivery failed");',"throw error;"]
]){const mutant=join(dirname(source),`.shu440-${token}.js`),changed=original.replace(from,to);if(changed===original)throw Error(`${token} mutant not applied`);try{writeFileSync(mutant,changed);const result=run(join(process.cwd(),mutant));if(result.error)throw result.error;const output=result.stdout+result.stderr;if(result.status===0)throw Error(`${token} mutant survived`);if(!new RegExp(`not ok [^\\n]*${token}`).test(output))throw Error(`${token} named test did not fail:\n${output}`)}finally{rmSync(mutant,{force:true})}}
