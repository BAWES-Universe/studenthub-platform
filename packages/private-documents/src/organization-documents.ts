/** Closed policy used by organization document wiring. Object keys and URLs are
 * deliberately absent; callers receive only opaque private-document metadata. */
export const ORGANIZATION_DOCUMENT_ACL = "private" as const;
export const ORGANIZATION_DOCUMENT_TYPES = ["company-logo","commercial-licence"] as const;
export function organizationDocumentInput(orgId:string,type:string,mime:string,bytes:Buffer){
 if(!ORGANIZATION_DOCUMENT_TYPES.includes(type as never))throw new TypeError("invalid organization document type");
 return {scope:{orgId},type:type as typeof ORGANIZATION_DOCUMENT_TYPES[number],mime,bytes,acl:ORGANIZATION_DOCUMENT_ACL};
}
