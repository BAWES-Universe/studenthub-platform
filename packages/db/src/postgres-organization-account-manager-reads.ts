import pg from "pg";
import { databaseUrl } from "./connection.js";

export class PostgresOrganizationAccountManagerReads {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  readonly #decision:(rows:readonly {readonly org_id:string;readonly role:string;readonly scope:string}[],org:string,ancestors:readonly string[])=>boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool; decision:(rows:readonly {readonly org_id:string;readonly role:string;readonly scope:string}[],org:string,ancestors:readonly string[])=>boolean }) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
    this.#decision=options.decision;
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  async readMany(orgIds: readonly string[]): Promise<Map<string, {principalId:string;displayName:string|null}>> {
    if (orgIds.length === 0) return new Map();
    const rows = await this.#pool.query<{ org_id: string; principal_id: string; display_name:string|null }>(
      "SELECT m.org_id,m.principal_id,p.display_name FROM organization_account_managers m JOIN principals p ON p.id=m.principal_id WHERE m.org_id = ANY($1::text[])", [orgIds],
    );
    if(rows.rows.length===0)return new Map();
    const [grants,ancestry]=await Promise.all([
      this.#pool.query<{principal_id:string;org_id:string;role:string;scope:string}>("SELECT principal_id,org_id,role,scope FROM grants WHERE principal_id=ANY($1::text[])",[[...new Set(rows.rows.map(row=>row.principal_id))]]),
      this.#pool.query<{target_id:string;id:string}>("WITH RECURSIVE chain(target_id,id,parent_org_id) AS (SELECT o.id,o.id,o.parent_org_id FROM organizations o WHERE o.id=ANY($1::text[]) UNION ALL SELECT c.target_id,o.id,o.parent_org_id FROM organizations o JOIN chain c ON c.parent_org_id=o.id) SELECT target_id,id FROM chain WHERE id<>target_id",[orgIds]),
    ]);
    const grantsByPrincipal=new Map<string,{org_id:string;role:string;scope:string}[]>(),ancestorsByOrg=new Map<string,string[]>();
    for(const row of grants.rows){const values=grantsByPrincipal.get(row.principal_id)??[];values.push(row);grantsByPrincipal.set(row.principal_id,values)}
    for(const row of ancestry.rows){const values=ancestorsByOrg.get(row.target_id)??[];values.push(row.id);ancestorsByOrg.set(row.target_id,values)}
    return new Map(rows.rows.filter(row=>this.#decision(grantsByPrincipal.get(row.principal_id)??[],row.org_id,ancestorsByOrg.get(row.org_id)??[])).map(row=>[row.org_id,{principalId:row.principal_id,displayName:row.display_name}]));
  }
}
