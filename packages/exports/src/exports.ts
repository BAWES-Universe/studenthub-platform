import { randomUUID } from "node:crypto";
import { writeCsv } from "./csv.js";

export const EXPORT_EXPIRY_MS = 15 * 60 * 1000;
export const EXPORT_ROW_CAP = 10_000;
export const EXPORT_BYTE_CAP = 5 * 1024 * 1024;
export type ExportOutcome = "created" | "refused_limit" | "refused_authorization";
/**
 * A kind's own file format, for files a CSV cannot be (an XLSX bank file, a bank's fixed text
 * format). The service stores the bytes with their content type and file name, and the
 * download serves them as they are. Everything else (closed filters, row whitelist, row and
 * byte caps, requester binding, 15-minute expiry, re-authorization at download and the audit
 * row) is the same as for CSV.
 */
export interface ExportFile { readonly bytes:Buffer;readonly contentType:string;readonly fileName:string }
/** A safe download name: letters, digits, dot, dash and underscore, 1 to 100 characters, not starting with a dot. */
export const EXPORT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A plain media type, optionally with charset=utf-8; no other parameters. */
export const EXPORT_CONTENT_TYPE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]{0,99}(?:; ?charset=utf-8)?$/;
export interface StoredExport { readonly id:string;readonly kind:string;readonly requesterPrincipalId:string;readonly filters:Readonly<Record<string,unknown>>;readonly rowCount:number;readonly outcome:ExportOutcome;readonly createdAt:Date;readonly expiresAt:Date;readonly bytes:Buffer|null;
  /** Set when the kind wrote its own format; null or absent for CSV. */
  readonly file?:{readonly contentType:string;readonly fileName:string}|null }
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
  /** Optional: write the rows in the kind's own format instead of CSV. Only whitelisted columns and rows reach it. */
  serialize?(columns:readonly string[],rows:readonly (readonly unknown[])[],filters:F):ExportFile|Promise<ExportFile>;
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
    let bytes:Buffer,file:StoredExport["file"]=null;
    if(kind.serialize){const own=await kind.serialize(kind.columns,rows,closed);if(!Buffer.isBuffer(own.bytes)||!EXPORT_FILE_NAME.test(own.fileName)||!EXPORT_CONTENT_TYPE.test(own.contentType))throw new TypeError(`export kind ${kindId} wrote an invalid file`);bytes=own.bytes;file={contentType:own.contentType,fileName:own.fileName};}
    else bytes=writeCsv(kind.columns,rows);
    if(bytes.byteLength>EXPORT_BYTE_CAP){await this.#save(principalId,kindId,closed,count,"refused_limit",null);return{ok:false,reason:"row_limit"};}
    const record=await this.#save(principalId,kindId,closed,count,"created",bytes,file);
    return{ok:true,id:record.id,downloadUrl:`/exports/${record.id}`,rowCount:count};
  }
  async download(principalId:string,id:string):Promise<Buffer|null>{return(await this.downloadFile(principalId,id))?.bytes??null;}
  /** The download with its kind id, so the caller can name the file after the kind. */
  async downloadFile(principalId:string,id:string):Promise<{readonly kind:string;readonly bytes:Buffer;readonly file:{readonly contentType:string;readonly fileName:string}|null}|null>{
    const record=await this.#store.find(id);if(!record||record.requesterPrincipalId!==principalId||record.outcome!=="created"||!record.bytes||record.expiresAt.getTime()<=this.#now().getTime())return null;
    const kind=this.#kinds.get(record.kind);if(!kind||!await kind.authorize(principalId,record.filters as never))return null;
    return{kind:record.kind,bytes:record.bytes,file:record.file??null};
  }
  cleanExpired():Promise<number>{return this.#store.cleanExpired(this.#now());}
  async #save(principalId:string,kind:string,filters:Readonly<Record<string,unknown>>,rowCount:number,outcome:ExportOutcome,bytes:Buffer|null,file:StoredExport["file"]=null){const createdAt=this.#now();const record:StoredExport={id:randomUUID(),kind,requesterPrincipalId:principalId,filters:Object.freeze({...filters}),rowCount,outcome,createdAt,expiresAt:new Date(createdAt.getTime()+EXPORT_EXPIRY_MS),bytes,file};await this.#store.save(record);return record;}
}
