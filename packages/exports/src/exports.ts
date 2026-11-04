import { randomUUID } from "node:crypto";
import { writeCsv } from "./csv.js";

export const EXPORT_EXPIRY_MS = 15 * 60 * 1000;
export const EXPORT_ROW_CAP = 10_000;
export const EXPORT_BYTE_CAP = 5 * 1024 * 1024;
export type ExportOutcome = "created" | "refused_limit" | "refused_authorization";
export interface StoredExport { readonly id:string;readonly kind:string;readonly requesterPrincipalId:string;readonly filters:Readonly<Record<string,unknown>>;readonly rowCount:number;readonly outcome:ExportOutcome;readonly createdAt:Date;readonly expiresAt:Date;readonly bytes:Buffer|null }
export interface ExportStore {
  save(record:StoredExport):Promise<void>;
  find(id:string):Promise<StoredExport|null>;
  cleanExpired(now:Date):Promise<number>;
}
export interface ExportKind<F extends Readonly<Record<string,unknown>>> {
  readonly id:string;
  readonly filterKeys:readonly (keyof F & string)[];
  readonly columns:readonly string[];
  authorize(principalId:string,filters:F):Promise<boolean>;
  rows(principalId:string,filters:F):AsyncIterable<readonly unknown[]>;
}
export type ExportRequestResult={readonly ok:true;readonly id:string;readonly downloadUrl:string;readonly rowCount:number}|{readonly ok:false;readonly reason:"not_found"|"row_limit"};

export class ExportService {
  readonly #store:ExportStore;readonly #kinds:ReadonlyMap<string,ExportKind<never>>;readonly #now:()=>Date;
  constructor(store:ExportStore,kinds:readonly ExportKind<never>[],now=()=>new Date()){this.#store=store;this.#kinds=new Map(kinds.map(kind=>[kind.id,kind]));this.#now=now;}
  async request<F extends Readonly<Record<string,unknown>>>(principalId:string,kindId:string,filters:F):Promise<ExportRequestResult>{
    const kind=this.#kinds.get(kindId) as ExportKind<F>|undefined;
    if(!kind)return{ok:false,reason:"not_found"};
    const closed=Object.freeze(Object.fromEntries(kind.filterKeys.filter(key=>filters[key]!==undefined).map(key=>[key,filters[key]]))) as F;
    if(!await kind.authorize(principalId,closed)){await this.#save(principalId,kindId,closed,0,"refused_authorization",null);return{ok:false,reason:"not_found"};}
    const rows:unknown[][]=[];let count=0;
    for await(const row of kind.rows(principalId,closed)){count++;if(count<=EXPORT_ROW_CAP)rows.push([...row]);}
    if(count>EXPORT_ROW_CAP){await this.#save(principalId,kindId,closed,count,"refused_limit",null);return{ok:false,reason:"row_limit"};}
    const bytes=writeCsv(kind.columns,rows);
    if(bytes.byteLength>EXPORT_BYTE_CAP){await this.#save(principalId,kindId,closed,count,"refused_limit",null);return{ok:false,reason:"row_limit"};}
    const record=await this.#save(principalId,kindId,closed,count,"created",bytes);
    return{ok:true,id:record.id,downloadUrl:`/exports/${record.id}`,rowCount:count};
  }
  async download(principalId:string,id:string):Promise<Buffer|null>{
    const record=await this.#store.find(id);if(!record||record.requesterPrincipalId!==principalId||record.outcome!=="created"||!record.bytes||record.expiresAt.getTime()<=this.#now().getTime())return null;
    const kind=this.#kinds.get(record.kind);if(!kind||!await kind.authorize(principalId,record.filters as never))return null;
    return record.bytes;
  }
  cleanExpired():Promise<number>{return this.#store.cleanExpired(this.#now());}
  async #save(principalId:string,kind:string,filters:Readonly<Record<string,unknown>>,rowCount:number,outcome:ExportOutcome,bytes:Buffer|null){const createdAt=this.#now();const record:StoredExport={id:randomUUID(),kind,requesterPrincipalId:principalId,filters:Object.freeze({...filters}),rowCount,outcome,createdAt,expiresAt:new Date(createdAt.getTime()+EXPORT_EXPIRY_MS),bytes};await this.#store.save(record);return record;}
}
