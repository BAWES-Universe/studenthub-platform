import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalEmbedHost, writeEmbedResponse, type UniverseEmbedConfig } from "./embed-policy.js";
import { handleUniverseEmbed } from "./embed-http.js";

/** Terminal before every ordinary handler. Disabling never releases the host. */
export function gateUniverseEmbedRequest(request: IncomingMessage, response: ServerResponse,
  config?: UniverseEmbedConfig): boolean {
  if (!config) return false;
  const hosts: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === "host") hosts.push(request.rawHeaders[index + 1]!);
  }
  const host = hosts.length === 1 ? canonicalEmbedHost(hosts[0]!) : undefined;
  if (host === undefined) {
    writeEmbedResponse(response, 400, '{"error":"bad_request"}', "application/json");
    return true;
  }
  if (host !== config.host) return false;
  if (!config.enabled) {
    writeEmbedResponse(response, 404, '{"error":"not_found"}', "application/json");
    return true;
  }
  handleUniverseEmbed(request, response, config);
  return true;
}
