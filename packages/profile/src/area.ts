export interface AreaChoice { readonly id:string; readonly nameEn:string; readonly nameAr:string|null; readonly governorateEn:string|null; readonly governorateAr:string|null; readonly latitude:number|null; readonly longitude:number|null }
export interface LocationRecord { readonly areaId:string|null; readonly areaNameEn:string|null; readonly areaNameAr:string|null; readonly latitude:number|null; readonly longitude:number|null; readonly revision:number; readonly writtenAt:string; readonly updatedAt:string }
export interface LocationSaveInput { readonly principalId:string; readonly areaId:string|null; readonly latitude:number|null; readonly longitude:number|null; readonly expectedRevision:number; readonly submissionId:string }
export type LocationSaveOutcome={readonly ok:true;readonly repeated:boolean}|{readonly ok:false;readonly reason:"stale_revision"|"invalid_area"|"no_change"};
export interface LocationStore { listAreas():Promise<readonly AreaChoice[]>; readOwn(principalId:string):Promise<LocationRecord|null>; save(input:LocationSaveInput):Promise<LocationSaveOutcome> }

export function validateCoordinates(latitude:unknown,longitude:unknown):Readonly<{latitude:number|null;longitude:number|null}>{
  if(latitude===null&&longitude===null)return Object.freeze({latitude:null,longitude:null});
  if(latitude===null||longitude===null)throw new TypeError("Enter both latitude and longitude.");
  const lat=typeof latitude==="number"?latitude:Number(latitude),lon=typeof longitude==="number"?longitude:Number(longitude);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))throw new TypeError("Coordinates must be numbers.");
  if(lat < -90 || lat > 90 || lon < -180 || lon > 180)throw new RangeError("Coordinates are outside the valid range.");
  return Object.freeze({latitude:Number(lat.toFixed(6)),longitude:Number(lon.toFixed(6))});
}
const radians=(n:number)=>n*Math.PI/180;
export function nearestArea(areas:readonly AreaChoice[],latitude:number,longitude:number):AreaChoice|null{
  let best:AreaChoice|null=null,bestDistance=Infinity;
  for(const area of areas){if(area.latitude===null||area.longitude===null)continue;const dLat=radians(area.latitude-latitude),dLon=radians(area.longitude-longitude);const a=Math.sin(dLat/2)**2+Math.cos(radians(latitude))*Math.cos(radians(area.latitude))*Math.sin(dLon/2)**2;const distance=6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));if(distance<bestDistance-1e-9||(Math.abs(distance-bestDistance)<=1e-9&&best!==null&&area.id<best.id)){best=area;bestDistance=distance;}}
  return bestDistance<=50?best:null;
}
export interface AreaGroup { readonly governorate:string; readonly areas:readonly Readonly<{id:string;name:string}>[] }
export function groupAreasByGovernorate(areas:readonly AreaChoice[],language:"en"|"ar"):readonly AreaGroup[]{
  const groups=new Map<string,{id:string;name:string}[]>();
  for(const area of areas){const governorate=(language==="ar"?area.governorateAr:area.governorateEn)??"Other areas";const name=language==="ar"&&area.nameAr?area.nameAr:area.nameEn;const values=groups.get(governorate)??[];values.push({id:area.id,name});groups.set(governorate,values);}
  return [...groups].sort(([a],[b])=>a.localeCompare(b,"en")).map(([governorate,values])=>Object.freeze({governorate,areas:Object.freeze(values.sort((a,b)=>a.name.localeCompare(b.name,"en")||a.id.localeCompare(b.id)).map(value=>Object.freeze(value)))}));
}
export class InMemoryLocationStore implements LocationStore{
  readonly #areas:readonly AreaChoice[];readonly #rows=new Map<string,LocationRecord>();readonly #submissions=new Set<string>();
  constructor(areas:readonly AreaChoice[]=[]){this.#areas=areas;}
  async listAreas(){return this.#areas;}
  async readOwn(id:string){return this.#rows.get(id)??null;}
  async save(input:LocationSaveInput):Promise<LocationSaveOutcome>{const key=`${input.principalId}\0${input.submissionId}`;if(this.#submissions.has(key))return {ok:true,repeated:true};const current=this.#rows.get(input.principalId);if((current?.revision??0)!==input.expectedRevision)return {ok:false,reason:"stale_revision"};const area=input.areaId===null?null:this.#areas.find(a=>a.id===input.areaId);if(input.areaId!==null&&!area)return {ok:false,reason:"invalid_area"};if((current?.areaId??null)===input.areaId&&(current?.latitude??null)===input.latitude&&(current?.longitude??null)===input.longitude)return {ok:false,reason:"no_change"};const now=new Date().toISOString();this.#rows.set(input.principalId,Object.freeze({areaId:input.areaId,areaNameEn:area?.nameEn??null,areaNameAr:area?.nameAr??null,latitude:input.latitude,longitude:input.longitude,revision:(current?.revision??0)+1,writtenAt:current?.writtenAt??now,updatedAt:now}));this.#submissions.add(key);return {ok:true,repeated:false};}
}
export function createArea(options:{store:LocationStore;clock?:()=>Date}){const {store}=options;return Object.freeze({readOwn:(id:string)=>store.readOwn(id),async choices(language:"en"|"ar"){return groupAreasByGovernorate(await store.listAreas(),language);},async suggest(latitude:unknown,longitude:unknown){const value=validateCoordinates(latitude,longitude);if(value.latitude===null||value.longitude===null)throw new TypeError("Coordinates are required.");return {coordinates:value,area:nearestArea(await store.listAreas(),value.latitude,value.longitude)};},async confirmation(principalId:string,latitude:unknown,longitude:unknown,language:"en"|"ar"){const value=validateCoordinates(latitude,longitude);if(value.latitude===null||value.longitude===null)throw new TypeError("Coordinates are required.");const [areas,current]=await Promise.all([store.listAreas(),store.readOwn(principalId)]);return {coordinates:value,area:nearestArea(areas,value.latitude,value.longitude),groups:groupAreasByGovernorate(areas,language),revision:current?.revision??0};},async save(input:LocationSaveInput){const coordinates=validateCoordinates(input.latitude,input.longitude);return store.save({...input,...coordinates});}});}
