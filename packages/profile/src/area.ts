export interface AreaChoice { readonly id:string; readonly nameEn:string; readonly nameAr?:string; readonly governorateEn?:string; readonly governorateAr?:string; readonly latitude?:number; readonly longitude?:number }
export interface PersonLocation { readonly areaId:string|null; readonly latitude:number|null; readonly longitude:number|null; readonly revision:number; readonly writtenAt:string }
export interface LocationStore {
  listAreas():Promise<readonly AreaChoice[]>;
  readOwn(principalId:string):Promise<PersonLocation|null>;
  save(input:{principalId:string;areaId:string|null;latitude:number|null;longitude:number|null;expectedRevision:number;submissionId:string}):Promise<PersonLocation>;
}
export class LocationConflictError extends Error { constructor(){super("Location changed. Review it and try again.");this.name="LocationConflictError"} }
export class LocationChoiceError extends Error { constructor(){super("Choose an active area.");this.name="LocationChoiceError"} }

export function validateCoordinates(latitude:number|null,longitude:number|null):Readonly<{latitude:number|null;longitude:number|null}>{
  if ((latitude===null)!==(longitude===null)) throw new TypeError("Provide both latitude and longitude.");
  if (latitude===null) return Object.freeze({latitude:null,longitude:null});
  if (!Number.isFinite(latitude)||!Number.isFinite(longitude!)) throw new TypeError("Coordinates must be finite numbers.");
  if (latitude < -90 || latitude > 90 || longitude! < -180 || longitude! > 180) throw new RangeError("Coordinates are outside the valid range.");
  return Object.freeze({latitude:Number(latitude.toFixed(6)),longitude:Number(longitude!.toFixed(6))});
}
const radians=(value:number)=>value*Math.PI/180;
export function nearestArea(areas:readonly AreaChoice[],latitude:number,longitude:number):AreaChoice|null{
  validateCoordinates(latitude,longitude); let best:AreaChoice|null=null,bestDistance=Infinity;
  for(const area of areas){if(area.latitude===undefined||area.longitude===undefined)continue;const dLat=radians(area.latitude-latitude),dLon=radians(area.longitude-longitude);const a=Math.sin(dLat/2)**2+Math.cos(radians(latitude))*Math.cos(radians(area.latitude))*Math.sin(dLon/2)**2;const distance=6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));if(distance<bestDistance||(Math.abs(distance-bestDistance)<1e-9&&best&&area.id<best.id)){best=area;bestDistance=distance}}
  return bestDistance<=50?best:null;
}
export function groupAreasByGovernorate(areas:readonly AreaChoice[],language:"en"|"ar"){
  const groups=new Map<string,AreaChoice[]>(); for(const area of areas){const key=(language==="ar"?area.governorateAr:area.governorateEn)||"Other areas";const list=groups.get(key)??[];list.push(area);groups.set(key,list)}
  return Object.freeze([...groups].sort(([a],[b])=>a.localeCompare(b)).map(([governorate,items])=>Object.freeze({governorate,areas:Object.freeze(items.map(area=>Object.freeze({...area,displayName:language==="ar"&&area.nameAr?area.nameAr:area.nameEn})).sort((a,b)=>a.displayName.localeCompare(b.displayName)||a.id.localeCompare(b.id)))})));
}
export class InMemoryLocationStore implements LocationStore{
  readonly #areas:readonly AreaChoice[];readonly #rows=new Map<string,PersonLocation>();readonly #submissions=new Map<string,PersonLocation>();
  constructor(areas:readonly AreaChoice[]=[]){this.#areas=areas}
  async listAreas(){return this.#areas} async readOwn(id:string){return this.#rows.get(id)??null}
  async save(input:Parameters<LocationStore["save"]>[0]){const prior=this.#submissions.get(`${input.principalId}:${input.submissionId}`);if(prior)return prior;const current=this.#rows.get(input.principalId);if((current?.revision??0)!==input.expectedRevision)throw new LocationConflictError();if(input.areaId!==null&&!this.#areas.some(a=>a.id===input.areaId))throw new LocationChoiceError();const coordinates=validateCoordinates(input.latitude,input.longitude);const row=Object.freeze({areaId:input.areaId,...coordinates,revision:(current?.revision??0)+1,writtenAt:new Date().toISOString()});this.#rows.set(input.principalId,row);this.#submissions.set(`${input.principalId}:${input.submissionId}`,row);return row}
}
export function createArea({store,clock=()=>new Date()}:{store:LocationStore;clock?:()=>Date}){void clock;return Object.freeze({readOwn:(principalId:string)=>store.readOwn(principalId),choices:()=>store.listAreas(),async suggest(latitude:number,longitude:number,areas?:readonly AreaChoice[]){const c=validateCoordinates(latitude,longitude);return nearestArea(areas??await store.listAreas(),c.latitude!,c.longitude!)},save:(input:Parameters<LocationStore["save"]>[0])=>store.save(input)})}
