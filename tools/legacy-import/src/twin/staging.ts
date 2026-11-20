/**
 * The staging side of a walk: the refreshed legacy copy over the mysql client, and the
 * new app on staging in a real browser.
 *
 * Read-only against legacy: every mysql session is `SET SESSION TRANSACTION READ ONLY`,
 * talks only to the `legacy_mirror` database, and binds integers and ISO dates only.
 * The new app is reached only at the staging origin. A walk signs a person in by writing
 * one short-lived session row for them and deletes it when their pages are read, the way
 * the browser acceptance fixture does; it writes nothing else.
 */

import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { spawnScoped } from "../refresh-cli.js";
import { MIRROR_DATABASE, type DatabaseUrl } from "../refresh.js";
import type { Journey, LegacyParam, LegacyReader } from "./journey.js";
import { WalkFailure, type NewApp } from "./walk.js";

export const STAGING_ORIGIN = "https://staging.studenthub.co";
const SESSION_COOKIE = "__Host-studenthub_session";

/** Replaces each `?` with a validated literal. Anything but a safe integer or a real ISO date is refused. */
export function bind(sql: string, params: readonly LegacyParam[]): string {
  if (!/^SELECT JSON_OBJECT\(/.test(sql) || /;|--|\/\*|#/.test(sql.replace(/'[^']*'/g, "''"))) throw new Error("twin.legacy.unsafeSql");
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    const p = params[i++];
    if (typeof p === "number") {
      if (!Number.isSafeInteger(p)) throw new Error("twin.legacy.badParam");
      return String(p);
    }
    if (p && typeof p === "object" && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && !Number.isNaN(Date.parse(`${p.date}T00:00:00Z`))
      && new Date(`${p.date}T00:00:00Z`).toISOString().startsWith(p.date)) return `'${p.date}'`;
    throw new Error("twin.legacy.badParam");
  });
  if (i !== params.length) throw new Error("twin.legacy.paramCount");
  return out;
}

/** One JSON object per line, as `mysql --batch --raw --skip-column-names` prints a `JSON_OBJECT` column. */
export function parseRows(stdout: string): Record<string, unknown>[] {
  return stdout.split("\n").filter((l) => l.length > 0).map((line) => {
    const row: unknown = JSON.parse(line);
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("twin.legacy.badRow");
    return row as Record<string, unknown>;
  });
}

export function mirrorReader(db: DatabaseUrl, signal?: AbortSignal): LegacyReader {
  if (db.database !== MIRROR_DATABASE) throw new Error("twin.legacy.notMirror");
  return {
    rows: (sql, params) => new Promise((resolve, reject) => {
      const statement = bind(sql, params);
      const child = spawnScoped({ signal }, "mysql", [
        `--host=${db.host}`, `--port=${db.port}`, `--user=${db.user}`, "--protocol=TCP", `--database=${MIRROR_DATABASE}`,
        "--init-command=SET SESSION TRANSACTION READ ONLY", "--batch", "--raw", "--skip-column-names", "--default-character-set=utf8mb4",
        `--execute=${statement}`,
      ], db, ["ignore", "pipe", "ignore"]);
      let out = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (c: string) => (out += c));
      child.on("error", () => undefined);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error("twin.legacy.queryFailed"));
        try { resolve(parseRows(out)); } catch { reject(new Error("twin.legacy.badRow")); }
      });
    }),
  };
}

/** Minimal Playwright surface the walk uses, so tests need no browser. */
export interface BrowserLike {
  newContext(options: { serviceWorkers: "block"; viewport: { width: number; height: number }; locale: string }): Promise<{
    addCookies(cookies: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: "Lax" }[]): Promise<void>;
    newPage(): Promise<{ goto(url: string, o: { waitUntil: "load"; timeout: number }): Promise<{ status(): number } | null>; content(): Promise<string>; url(): string }>;
    close(): Promise<void>;
  }>;
}

export interface SessionPort {
  put(record: { id: string; personId: string }): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Who a legacy id is on the platform: the import id map first, then a legacy sign-in link. */
export async function linkedPerson(pool: Pick<Pool, "query">, legacyId: string, persona: Journey["persona"]): Promise<string | undefined> {
  if (persona !== "candidate") return undefined;
  const mapped = await pool.query<{ platform_id: string }>(
    "SELECT platform_id FROM legacy_id_maps WHERE legacy_table = 'candidate' AND legacy_id = $1 AND entity = 'person'", [legacyId]);
  if (mapped.rows[0]) return mapped.rows[0].platform_id;
  const linked = await pool.query<{ principal_id: string }>("SELECT principal_id FROM legacy_account_links WHERE legacy_candidate_id = $1", [legacyId]);
  return linked.rows[0]?.principal_id;
}

export function stagingApp(browser: BrowserLike, sessions: SessionPort, people: NewApp["personFor"], origin = STAGING_ORIGIN): NewApp {
  if (origin !== STAGING_ORIGIN) throw new Error("twin.app.notStaging");
  const host = new URL(origin).host;
  return {
    personFor: people,
    async open(personId, paths) {
      const token = randomBytes(32).toString("base64url");
      await sessions.put({ id: token, personId });
      const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 }, locale: "en-GB" });
      try {
        await context.addCookies([{ name: SESSION_COOKIE, value: token, domain: host, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
        const page = await context.newPage();
        const html: string[] = [];
        for (const path of paths) {
          if (!path.startsWith("/") || path.startsWith("//")) throw new WalkFailure("page_failed");
          let response;
          try { response = await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 30_000 }); } catch { throw new WalkFailure("timeout"); }
          if (!response || response.status() !== 200) throw new WalkFailure("page_failed");
          // A redirect to sign-in means the session was not accepted.
          if (new URL(page.url()).pathname.startsWith("/login")) throw new WalkFailure("sign_in_failed");
          html.push(await page.content());
        }
        return html;
      } finally {
        await context.close().catch(() => undefined);
        await sessions.delete(token);
      }
    },
  };
}
