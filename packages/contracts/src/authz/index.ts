import { CONTRACT_VERSIONS } from "../versions.js";

export * from "./roles.js";
export * from "./principal.js";
export * from "./organization.js";
export * from "./grants.js";
export * from "./store.js";
export * from "./context.js";
export * from "./assertion.js";
export * from "./registry.js";

/** Version of the authz contract slot (see ../versions.ts). */
export const AUTHZ_CONTRACT_VERSION = CONTRACT_VERSIONS.authz;
export type AuthzContractVersion = typeof AUTHZ_CONTRACT_VERSION;
