import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { handleCivilId, renderCivilIdRow } from "../src/civil-id-http.js";

test("Q14_3_SHOWN row shows only the mask, expiry, review state and change link",()=>{const html=renderCivilIdRow("en",{country:"KW",maskedNumber:"•••• •••• 0000",expiry:"2027-03-01",needsReview:true});assert.match(html,/•••• •••• 0000/);assert.match(html,/expires 2027-03-01/);assert.match(html,/Waiting for StudentHub to check/);assert.match(html,/href="\/profile\/civil-id"/);assert.doesNotMatch(html,/290010100000/);});
test("Q14_3_PAGE feature-off route is 404",async()=>{const request=Readable.from([]) as Readable&{url?:string;method?:string;headers:Record<string,string>};request.url="/profile/civil-id";request.method="GET";request.headers={};const response=new EventEmitter() as EventEmitter&{statusCode:number;writeHead(s:number):void;end():void};response.statusCode=200;response.writeHead=s=>{response.statusCode=s;};response.end=()=>{};assert.equal(await handleCivilId(request as never,response as never,undefined,undefined,async()=>undefined,()=>{}),true);assert.equal(response.statusCode,404);});
test("Q14_3_SECRECY gateway pages never call the explicit decrypt method",async()=>{for(const file of await readdir(new URL("../src/",import.meta.url))){if(!file.endsWith(".ts"))continue;const source=await readFile(new URL(`../src/${file}`,import.meta.url),"utf8");if(file!=="wiring")assert.doesNotMatch(source,/decryptNumber\s*\(/,file);}});
