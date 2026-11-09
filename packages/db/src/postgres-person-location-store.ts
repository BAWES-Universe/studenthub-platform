import pg from "pg";
import { databaseUrl } from "./connection.js";
interface AreaChoice { readonly id:string; readonly nameEn:string; readonly nameAr:string|null; readonly governorateEn:string|null; readonly governorateAr:string|null; readonly latitude:number|null; readonly longitude:number|null }
interface LocationRecord { readonly areaId:string|null; readonly areaNameEn:string|null; readonly areaNameAr:string|null; readonly latitude:number|null; readonly longitude:number|null; readonly revision:number; readonly writtenAt:string; readonly updatedAt:string }
interface LocationSaveInput { readonly principalId:string; readonly areaId:string|null; readonly latitude:number|null; readonly longitude:number|null; readonly expectedRevision:number; readonly submissionId:string }
type LocationSaveOutcome={readonly ok:true;readonly repeated:boolean}|{readonly ok:false;readonly reason:"stale_revision"|"invalid_area"|"no_change"};

export class PostgresPersonLocationStore {
  readonly #pool: pg.Pool; readonly #ownsPool: boolean;
  constructor(options: {connectionString?: string; pool?: pg.Pool} = {}) { this.#ownsPool=!options.pool; this.#pool=options.pool ?? new pg.Pool({connectionString:options.connectionString ?? databaseUrl()}); }
  async close(){ if(this.#ownsPool) await this.#pool.end(); }
  async listAreas(): Promise<readonly AreaChoice[]> {
    const {rows}=await this.#pool.query(`SELECT i.id::text,i.name,d.name_ar,d.governorate_en,d.governorate_ar,d.latitude::text,d.longitude::text
      FROM catalogue_items i LEFT JOIN catalogue_area_details d ON d.area_id=i.id
      WHERE i.catalogue_type='area' AND i.status='active'
      ORDER BY COALESCE(d.governorate_en,'Other areas') COLLATE "C",i.name COLLATE "C",i.id`);
    return rows.map(r=>Object.freeze({id:r.id,nameEn:r.name,nameAr:r.name_ar??null,governorateEn:r.governorate_en??null,governorateAr:r.governorate_ar??null,latitude:r.latitude===null?null:Number(r.latitude),longitude:r.longitude===null?null:Number(r.longitude)}));
  }
  async readOwn(principalId:string): Promise<LocationRecord|null> {
    const {rows}=await this.#pool.query(`SELECT l.area_id::text,l.latitude::text,l.longitude::text,l.revision,l.written_at,l.updated_at,i.name,d.name_ar
      FROM person_locations l LEFT JOIN catalogue_items i ON i.id=l.area_id LEFT JOIN catalogue_area_details d ON d.area_id=l.area_id WHERE l.principal_id=$1::text`,[principalId]);
    const r=rows[0]; if(!r)return null;
    return Object.freeze({areaId:r.area_id,areaNameEn:r.name??null,areaNameAr:r.name_ar??null,latitude:r.latitude===null?null:Number(r.latitude),longitude:r.longitude===null?null:Number(r.longitude),revision:r.revision,writtenAt:r.written_at.toISOString(),updatedAt:r.updated_at.toISOString()});
  }
  async save(input:LocationSaveInput):Promise<LocationSaveOutcome>{
    const client=await this.#pool.connect();
    try { await client.query("BEGIN");
      if(input.areaId!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.areaId)){await client.query("ROLLBACK");return {ok:false,reason:"invalid_area"};}
      const duplicate=await client.query(`SELECT 1 FROM person_location_events WHERE principal_id=$1::text AND submission_id=$2::uuid`,[input.principalId,input.submissionId]);
      if(duplicate.rowCount){await client.query("COMMIT");return {ok:true,repeated:true};}
      const current=(await client.query(`SELECT area_id::text,latitude::text,longitude::text,revision FROM person_locations WHERE principal_id=$1::text FOR UPDATE`,[input.principalId])).rows[0];
      if((current?.revision??0)!==input.expectedRevision){await client.query("ROLLBACK");return {ok:false,reason:"stale_revision"};}
      if(input.areaId!==null){const valid=await client.query(`SELECT 1 FROM catalogue_items WHERE id=$1::uuid AND catalogue_type='area' AND status='active'`,[input.areaId]);if(!valid.rowCount){await client.query("ROLLBACK");return {ok:false,reason:"invalid_area"};}}
      const changed:string[]=[]; if((current?.area_id??null)!==input.areaId)changed.push("area");
      if((current?.latitude===null?null:Number(current?.latitude))!==input.latitude||(current?.longitude===null?null:Number(current?.longitude))!==input.longitude)changed.push("coordinates");
      if(!changed.length){await client.query("ROLLBACK");return {ok:false,reason:"no_change"};}
      const now=new Date(); await client.query(`INSERT INTO person_locations(principal_id,area_id,latitude,longitude,revision,written_at,updated_at)
       VALUES($1::text,$2::uuid,$3::numeric,$4::numeric,1,$5::timestamptz,$5::timestamptz) ON CONFLICT(principal_id) DO UPDATE SET area_id=EXCLUDED.area_id,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,revision=person_locations.revision+1,updated_at=EXCLUDED.updated_at`,[input.principalId,input.areaId,input.latitude,input.longitude,now]);
      await client.query(`INSERT INTO person_location_events(principal_id,submission_id,kind,changed,occurred_at) VALUES($1::text,$2::uuid,'location_changed',$3::text[],$4::timestamptz)`,[input.principalId,input.submissionId,changed,now]);
      await client.query("COMMIT"); return {ok:true,repeated:false};
    }catch(e){try{await client.query("ROLLBACK");}catch{}throw e;}finally{client.release();}
  }
}
