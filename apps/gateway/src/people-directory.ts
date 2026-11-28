import type { AuthzStore } from "@studenthub/contracts";
import type { SessionStore } from "@studenthub/login-contract";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { PEOPLE_PAGE_SIZE, kuwaitDate, type PeopleDirectoryQuery, type PeopleDirectoryRow, type PeopleDirectoryStore } from "@studenthub/profile";

const KEYS=new Set(["q","status","nationality","civil","details","page"]);
const STATUS=new Set(["not_looking","active","open_to_offers","unset"]),CIVIL=new Set(["none","waiting","rejected","expired","checked","recorded"]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parsePeopleDirectoryQuery(params:URLSearchParams):PeopleDirectoryQuery|null{
  for(const key of new Set(params.keys()))if(!KEYS.has(key)||params.getAll(key).length!==1)return null;
  const result:{q?:string;status?:PeopleDirectoryQuery["status"];nationality?:string;civil?:PeopleDirectoryQuery["civil"];details?:PeopleDirectoryQuery["details"];page:number}={page:1};
  const q=params.get("q")?.trim();if(q){if([...q].length>100)return null;result.q=q}
  const status=params.get("status");if(status){if(!STATUS.has(status))return null;result.status=status as PeopleDirectoryQuery["status"]}
  const nationality=params.get("nationality");if(nationality){if(!UUID.test(nationality))return null;result.nationality=nationality}
  const civil=params.get("civil");if(civil){if(!CIVIL.has(civil))return null;result.civil=civil as PeopleDirectoryQuery["civil"]}
  const details=params.get("details");if(details){if(details!=="complete"&&details!=="missing")return null;result.details=details}
  const page=params.get("page");if(page!==null){if(!/^[1-9]\d{0,5}$/.test(page))return null;result.page=Number(page)}
  return Object.freeze(result);
}
const peopleStaffGrant=(grants:Awaited<ReturnType<AuthzStore["listGrantsForPrincipal"]>>)=>grants.find(g=>(g.role==="staff"||g.role==="admin")&&g.scope==="subtree"&&(DEFAULT_OPERATOR_ORG_IDS as readonly string[]).includes(g.orgId));
export async function isPeopleStaff(authz:Pick<AuthzStore,"listGrantsForPrincipal">,principalId:string):Promise<boolean>{return Boolean(peopleStaffGrant(await authz.listGrantsForPrincipal(principalId)))}
export type PeopleDirectoryBody={readonly rows:readonly PeopleDirectoryRow[];readonly total:number;readonly page:number;readonly pageSize:number;readonly query:PeopleDirectoryQuery;readonly countries:readonly {id:string;name:string}[];readonly active:{readonly orgId:string;readonly role:"staff"|"admin"}};
export type PeopleDirectoryResult={status:200;body:PeopleDirectoryBody}|{status:400|401|404|503;body:{error:string}};
export type PersonDetailResult={status:200;body:{readonly person:PeopleDirectoryRow;readonly active:{readonly orgId:string;readonly role:"staff"|"admin"}}}|{status:401|404|503;body:{error:string}};
/** Principal ids as the staff person pages take them (the same shape as the message and email log pages). */
export const PERSON_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export interface PeopleDirectoryPage{open(session:string|undefined,params:URLSearchParams,html:boolean):Promise<PeopleDirectoryResult>;person?(session:string|undefined,principalId:string):Promise<PersonDetailResult>}
export function createPeopleDirectory(options:{sessions:Pick<SessionStore,"get">;authz:Pick<AuthzStore,"listGrantsForPrincipal">;store:PeopleDirectoryStore;choices:()=>Promise<{countries:readonly {id:string;name:string}[]}>;now?:()=>Date}):PeopleDirectoryPage{
  return{async open(sessionId,params,html){
    const session=sessionId?await options.sessions.get(sessionId):undefined;if(!session)return{status:401,body:{error:"unauthorized"}};
    const active=peopleStaffGrant(await options.authz.listGrantsForPrincipal(session.personId));if(!active)return{status:404,body:{error:"not_found"}};
    const query=parsePeopleDirectoryQuery(params);if(!query)return{status:400,body:{error:"invalid_people_query"}};
    try{const [{rows,total},choices]=await Promise.all([options.store.page(query,kuwaitDate((options.now??(()=>new Date()))())),html?options.choices():Promise.resolve({countries:[]})]);return{status:200,body:{rows,total,page:query.page,pageSize:PEOPLE_PAGE_SIZE,query,countries:choices.countries.map(x=>({id:x.id,name:x.name})),active:{orgId:active.orgId,role:active.role as "staff"|"admin"}}}}catch{return{status:503,body:{error:"directory_unavailable"}}}
  },
  /** One person's directory facts for operator staff and admin; anyone else, a bad id or no such person is the same 404. */
  async person(sessionId,principalId){
    const session=sessionId?await options.sessions.get(sessionId):undefined;if(!session)return{status:401,body:{error:"unauthorized"}};
    const active=peopleStaffGrant(await options.authz.listGrantsForPrincipal(session.personId));if(!active||!PERSON_ID.test(principalId))return{status:404,body:{error:"not_found"}};
    if(!options.store.person)return{status:503,body:{error:"directory_unavailable"}};
    let person;try{person=await options.store.person(principalId,kuwaitDate((options.now??(()=>new Date()))()))}catch{return{status:503,body:{error:"directory_unavailable"}}}
    return person&&person.principalId===principalId?{status:200,body:{person,active:{orgId:active.orgId,role:active.role as "staff"|"admin"}}}:{status:404,body:{error:"not_found"}};
  }};
}
