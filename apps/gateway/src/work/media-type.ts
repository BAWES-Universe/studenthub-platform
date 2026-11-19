// The media type of a request body, without its parameters: `Application/JSON; charset=utf-8`
// is `application/json`. Header values are case-insensitive and may carry whitespace
// around the type and before each parameter (RFC 9110 §8.3.1).
import type { IncomingMessage } from "node:http";

export function mediaType(req: IncomingMessage): string | undefined {
  const header = req.headers["content-type"];
  if (typeof header !== "string") return undefined;
  const essence = header.split(";", 1)[0]!.trim().toLowerCase();
  return essence === "" ? undefined : essence;
}
