export interface AreaChoice {
  readonly id: string;
  readonly nameEn: string;
  readonly nameAr?: string;
  readonly governorateEn?: string;
  readonly governorateAr?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface PersonLocation {
  readonly areaId: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly revision: number;
  readonly updatedAt: string;
}

export type LocationSave = Readonly<{ principalId:string; areaId:string|null; latitude:number|null; longitude:number|null; expectedRevision:number; submissionId:string }>;
export type LocationSaveResult = Readonly<{ ok:true; location:PersonLocation; reused?:boolean }> | Readonly<{ ok:false; reason:"stale_revision"|"area_unavailable" }>;

export interface LocationStore {
  listAreas(): Promise<readonly AreaChoice[]>;
  readOwn(principalId:string): Promise<PersonLocation|null>;
  save(input:LocationSave): Promise<LocationSaveResult>;
}

export function validateCoordinates(latitude:unknown,longitude:unknown):Readonly<{latitude:number|null;longitude:number|null}>{
  if(latitude===null&&longitude===null)return {latitude:null,longitude:null};
  if(latitude===null||longitude===null)throw new TypeError("Provide both latitude and longitude.");
  if(typeof latitude!=="number"||typeof longitude!=="number"||!Number.isFinite(latitude)||!Number.isFinite(longitude))throw new TypeError("Coordinates must be numbers.");
  if(latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)throw new RangeError("Coordinates are outside the valid range.");
  return {latitude:Number(latitude.toFixed(6)),longitude:Number(longitude.toFixed(6))};
}

const distance=(a:number,b:number,c:number,d:number)=>{const r=Math.PI/180,p1=a*r,p2=c*r,dp=(c-a)*r,dl=(d-b)*r;const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));};
export function nearestArea(areas:readonly AreaChoice[],latitude:number,longitude:number):AreaChoice|null{
  validateCoordinates(latitude,longitude);let best:AreaChoice|null=null,bestDistance=Infinity;
  for(const area of areas){if(area.latitude===undefined||area.longitude===undefined)continue;const current=distance(latitude,longitude,area.latitude,area.longitude);if(current<bestDistance || current===bestDistance && area.id<(best?.id??"")){best=area;bestDistance=current;}}
  return bestDistance<=50?best:null;
}

export interface AreaGroup { readonly governorate:string; readonly areas:readonly Readonly<{id:string;name:string}>[] }
export function groupAreasByGovernorate(areas:readonly AreaChoice[],language:"en"|"ar"):readonly AreaGroup[]{
  const grouped=new Map<string,{id:string;name:string}[]>();
  for(const area of areas){const governorate=(language==="ar"?area.governorateAr:area.governorateEn)||"Other areas";const name=language==="ar"&&area.nameAr?area.nameAr:area.nameEn;(grouped.get(governorate)??(grouped.set(governorate,[]),grouped.get(governorate)!)).push({id:area.id,name});}
  return [...grouped].sort(([a],[b])=>a.localeCompare(b,"en")).map(([governorate,values])=>({governorate,areas:values.sort((a,b)=>a.name.localeCompare(b.name,"en")||a.id.localeCompare(b.id))}));
}

export class InMemoryLocationStore implements LocationStore{
  readonly #areas:readonly AreaChoice[];readonly #rows=new Map<string,PersonLocation>();readonly #submissions=new Map<string,LocationSaveResult>();
  constructor(areas:readonly AreaChoice[]=[]){this.#areas=areas;}
  async listAreas(){return this.#areas;}
  async readOwn(id:string){return this.#rows.get(id)??null;}
  async save(input:LocationSave):Promise<LocationSaveResult>{const key=`${input.principalId}:${input.submissionId}`,prior=this.#submissions.get(key);if(prior)return prior.ok?{...prior,reused:true}:prior;const current=this.#rows.get(input.principalId);if((current?.revision??0)!==input.expectedRevision)return {ok:false,reason:"stale_revision"};if(input.areaId!==null&&!this.#areas.some(a=>a.id===input.areaId))return {ok:false,reason:"area_unavailable"};const location={areaId:input.areaId,latitude:input.latitude,longitude:input.longitude,revision:(current?.revision??0)+1,updatedAt:new Date().toISOString()};this.#rows.set(input.principalId,location);const result={ok:true as const,location};this.#submissions.set(key,result);return result;}
}

export function createArea({store,clock=()=>new Date()}:{store:LocationStore;clock?:()=>Date}){
  void clock;
  return { readOwn:(principalId:string)=>store.readOwn(principalId), choices:()=>store.listAreas(), async suggest(latitude:number,longitude:number){return nearestArea(await store.listAreas(),latitude,longitude);}, async save(input:LocationSave){const coordinates=validateCoordinates(input.latitude,input.longitude);return store.save({...input,...coordinates});} };
}
export type AreaService=ReturnType<typeof createArea>;
