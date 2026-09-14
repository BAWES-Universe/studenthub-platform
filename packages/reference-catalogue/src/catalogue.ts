import { randomUUID } from "node:crypto";
import type { Role } from "@studenthub/contracts";
import {
  isCatalogueType, isSubmittableCatalogueType,
  type CatalogueActor, type CatalogueItem, type CatalogueItemInput,
  type CataloguePage, type CatalogueSortKey, type CatalogueStore,
  type CatalogueSubmission, type CatalogueType, type SubmittableCatalogueType,
} from "./types.js";

const MAX_PAGE_SIZE = 100;
const WRITE_ROLES = new Set<Role>(["staff", "admin"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CatalogueError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503) {
    super(code);
  }
}

export function normalizeCatalogueInput(value: unknown): CatalogueItemInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CatalogueError("invalid_catalogue_input", 400);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "name" && key !== "code")) throw new CatalogueError("invalid_catalogue_input", 400);
  if (typeof raw.name !== "string") throw new CatalogueError("invalid_catalogue_input", 400);
  const name = raw.name.trim().replace(/\s+/gu, " ").normalize("NFKC");
  if (name.length < 1 || name.length > 160 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new CatalogueError("invalid_catalogue_name", 400);
  if (raw.code === undefined) return Object.freeze({ name });
  if (typeof raw.code !== "string") throw new CatalogueError("invalid_catalogue_code", 400);
  const code = raw.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(code)) throw new CatalogueError("invalid_catalogue_code", 400);
  return Object.freeze({ name, code });
}

export function catalogueSortKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US");
}

function pageSize(value: unknown): number {
  if (value === undefined || value === null || value === "") return 25;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) throw new CatalogueError("invalid_page_size", 400);
  return parsed;
}

function encodeCursor(type: string, item: { readonly name?: string; readonly submittedAt?: string; readonly id: string }): string {
  const sortKey = type.startsWith("submission:") ? item.submittedAt! : catalogueSortKey(item.name!);
  return Buffer.from(JSON.stringify({ v: 1, type, sortKey, id: item.id }), "utf8").toString("base64url");
}

function decodeCursor(raw: unknown, type: string): CatalogueSortKey | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 1024) throw new CatalogueError("invalid_cursor", 400);
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const decoded = Buffer.from(raw, "base64url");
    if (decoded.toString("base64url") !== raw) throw new Error();
    const parsed = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(",") !== "id,sortKey,type,v" || parsed.v !== 1 || parsed.type !== type
      || typeof parsed.sortKey !== "string" || typeof parsed.id !== "string"
      || parsed.sortKey.length > 200 || !UUID_PATTERN.test(parsed.id)) throw new Error();
    return { sortKey: parsed.sortKey, id: parsed.id };
  } catch {
    throw new CatalogueError("invalid_cursor", 400);
  }
}

function requireWriter(actor: CatalogueActor): void {
  if (!WRITE_ROLES.has(actor.role)) throw new CatalogueError("catalogue_write_forbidden", 403);
}

function requireCandidate(actor: CatalogueActor): void {
  if (actor.role !== "candidate") throw new CatalogueError("catalogue_submission_forbidden", 403);
}

function requireId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new CatalogueError("invalid_catalogue_id", 400);
  }
}

function createPage<T extends { readonly id: string; readonly name?: string; readonly submittedAt?: string }>(
  rows: readonly T[], limit: number, cursorType: string,
): CataloguePage<T> {
  const items = rows.slice(0, limit);
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: rows.length > limit ? encodeCursor(cursorType, items[items.length - 1]!) : null,
  });
}

export class ReferenceCatalogue {
  constructor(private readonly store: CatalogueStore, private readonly now: () => Date = () => new Date()) {}

  async list(typeValue: unknown, options: { readonly cursor?: unknown; readonly pageSize?: unknown } = {}): Promise<CataloguePage<CatalogueItem>> {
    if (!isCatalogueType(typeValue)) throw new CatalogueError("unknown_catalogue_type", 404);
    const limit = pageSize(options.pageSize);
    const rows = await this.store.listActive(typeValue, decodeCursor(options.cursor, typeValue), limit + 1);
    return createPage(rows, limit, typeValue);
  }

  async resolveHistorical(typeValue: unknown, id: string): Promise<CatalogueItem | undefined> {
    if (!isCatalogueType(typeValue)) throw new CatalogueError("unknown_catalogue_type", 404);
    requireId(id);
    return this.store.resolveById(typeValue, id);
  }

  async create(actor: CatalogueActor, typeValue: unknown, raw: unknown): Promise<CatalogueItem> {
    requireWriter(actor);
    if (!isCatalogueType(typeValue)) throw new CatalogueError("unknown_catalogue_type", 404);
    const input = normalizeCatalogueInput(raw);
    const now = this.now().toISOString();
    try {
      return await this.store.createItem({ id: randomUUID(), type: typeValue, ...input, status: "active", createdAt: now, updatedAt: now, actorRef: actor.principalRef });
    } catch (error) {
      if (error instanceof CatalogueError) throw error;
      throw new CatalogueError("catalogue_conflict", 409);
    }
  }

  async update(actor: CatalogueActor, typeValue: unknown, id: string, raw: unknown): Promise<CatalogueItem> {
    requireWriter(actor);
    if (!isCatalogueType(typeValue)) throw new CatalogueError("unknown_catalogue_type", 404);
    requireId(id);
    let item: CatalogueItem | undefined;
    try {
      item = await this.store.updateItem(typeValue, id, { ...normalizeCatalogueInput(raw), actorRef: actor.principalRef, now: this.now().toISOString() });
    } catch (error) {
      if (error instanceof CatalogueError) throw error;
      throw new CatalogueError("catalogue_conflict", 409);
    }
    if (!item) throw new CatalogueError("catalogue_item_not_found", 404);
    return item;
  }

  async remove(actor: CatalogueActor, typeValue: unknown, id: string): Promise<CatalogueItem> {
    requireWriter(actor);
    if (!isCatalogueType(typeValue)) throw new CatalogueError("unknown_catalogue_type", 404);
    requireId(id);
    const item = await this.store.softDeleteItem(typeValue, id, actor.principalRef, this.now().toISOString());
    if (!item) throw new CatalogueError("catalogue_item_not_found", 404);
    return item;
  }

  async submit(actor: CatalogueActor, typeValue: unknown, raw: unknown): Promise<CatalogueSubmission> {
    requireCandidate(actor);
    if (!isSubmittableCatalogueType(typeValue)) throw new CatalogueError("catalogue_type_not_submittable", 400);
    const input = normalizeCatalogueInput(raw);
    const now = this.now().toISOString();
    try {
      return await this.store.createSubmission({ id: randomUUID(), type: typeValue, ...input, status: "pending", submittedAt: now, actorRef: actor.principalRef, orgId: actor.orgId });
    } catch {
      throw new CatalogueError("catalogue_submission_conflict", 409);
    }
  }

  async submissions(actor: CatalogueActor, options: { readonly status?: unknown; readonly type?: unknown; readonly cursor?: unknown; readonly pageSize?: unknown } = {}): Promise<CataloguePage<CatalogueSubmission>> {
    requireWriter(actor);
    const status = options.status ?? "pending";
    if (status !== "pending" && status !== "approved" && status !== "rejected") throw new CatalogueError("invalid_submission_status", 400);
    const type = options.type === undefined || options.type === "" ? undefined : options.type;
    if (type !== undefined && !isSubmittableCatalogueType(type)) throw new CatalogueError("catalogue_type_not_submittable", 400);
    const limit = pageSize(options.pageSize);
    const cursorType = `submission:${status}:${type ?? "all"}`;
    const rows = await this.store.listSubmissions(status, type, decodeCursor(options.cursor, cursorType), limit + 1);
    return createPage(rows, limit, cursorType);
  }

  async moderate(actor: CatalogueActor, id: string, decision: unknown): Promise<CatalogueSubmission> {
    requireWriter(actor);
    requireId(id);
    if (decision !== "approved" && decision !== "rejected") throw new CatalogueError("invalid_moderation_decision", 400);
    let result: CatalogueSubmission | undefined;
    try {
      result = await this.store.moderateSubmission(id, decision, actor.principalRef, this.now().toISOString(), randomUUID());
    } catch (error) {
      if (error instanceof CatalogueError) throw error;
      throw new CatalogueError("catalogue_conflict", 409);
    }
    if (!result) throw new CatalogueError("catalogue_submission_not_pending", 409);
    return result;
  }
}
