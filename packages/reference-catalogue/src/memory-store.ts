import { CatalogueError, catalogueSortKey } from "./catalogue.js";
import type {
  CatalogueItem, CatalogueItemInput, CatalogueSortKey, CatalogueStore,
  CatalogueSubmission, CatalogueType, SubmittableCatalogueType,
} from "./types.js";

function afterKey(row: { readonly name?: string; readonly submittedAt?: string; readonly id: string }, after?: CatalogueSortKey): boolean {
  if (!after) return true;
  const key = row.name === undefined ? row.submittedAt! : catalogueSortKey(row.name);
  return key > after.sortKey || (key === after.sortKey && row.id > after.id);
}

export class InMemoryCatalogueStore implements CatalogueStore {
  readonly #items = new Map<string, CatalogueItem>();
  readonly #submissions = new Map<string, CatalogueSubmission>();

  async listActive(type: CatalogueType, after: CatalogueSortKey | undefined, limit: number): Promise<readonly CatalogueItem[]> {
    return [...this.#items.values()].filter((item) => item.type === type && item.status === "active" && afterKey(item, after))
      .sort((a, b) => compare(catalogueSortKey(a.name), catalogueSortKey(b.name)) || compare(a.id, b.id))
      .slice(0, limit);
  }

  async resolveById(type: CatalogueType, id: string): Promise<CatalogueItem | undefined> {
    const item = this.#items.get(id);
    return item?.type === type ? item : undefined;
  }

  async createItem(input: CatalogueItem & { readonly actorRef: string }): Promise<CatalogueItem> {
    if ([...this.#items.values()].some((item) => item.type === input.type && item.status === "active" && catalogueSortKey(item.name) === catalogueSortKey(input.name))) {
      throw new CatalogueError("catalogue_conflict", 409);
    }
    const { actorRef: _actorRef, ...item } = input;
    this.#items.set(item.id, Object.freeze(item));
    return item;
  }

  async updateItem(type: CatalogueType, id: string, input: CatalogueItemInput & { readonly actorRef: string; readonly now: string }): Promise<CatalogueItem | undefined> {
    const current = this.#items.get(id);
    if (!current || current.type !== type || current.status !== "active") return undefined;
    if ([...this.#items.values()].some((item) => item.id !== id && item.type === type && item.status === "active" && catalogueSortKey(item.name) === catalogueSortKey(input.name))) {
      throw new CatalogueError("catalogue_conflict", 409);
    }
    const next = Object.freeze({ ...current, name: input.name, ...(input.code === undefined ? { code: undefined } : { code: input.code }), updatedAt: input.now });
    this.#items.set(id, next);
    return next;
  }

  async softDeleteItem(type: CatalogueType, id: string, _actorRef: string, now: string): Promise<CatalogueItem | undefined> {
    const current = this.#items.get(id);
    if (!current || current.type !== type || current.status !== "active") return undefined;
    const next = Object.freeze({ ...current, status: "deleted" as const, deletedAt: now, updatedAt: now });
    this.#items.set(id, next);
    return next;
  }

  async createSubmission(input: CatalogueSubmission & { readonly actorRef: string; readonly orgId: string }): Promise<CatalogueSubmission> {
    if ([...this.#submissions.values()].some((item) => item.type === input.type && item.status === "pending" && catalogueSortKey(item.name) === catalogueSortKey(input.name))) throw new Error("duplicate");
    const { actorRef: _actorRef, orgId: _orgId, ...submission } = input;
    this.#submissions.set(submission.id, Object.freeze(submission));
    return submission;
  }

  async listSubmissions(status: CatalogueSubmission["status"], type: SubmittableCatalogueType | undefined, after: CatalogueSortKey | undefined, limit: number): Promise<readonly CatalogueSubmission[]> {
    return [...this.#submissions.values()].filter((item) => item.status === status && (type === undefined || item.type === type) && afterKey(item, after))
      .sort((a, b) => compare(a.submittedAt, b.submittedAt) || compare(a.id, b.id)).slice(0, limit);
  }

  async moderateSubmission(id: string, decision: "approved" | "rejected", _actorRef: string, now: string, itemId: string): Promise<CatalogueSubmission | undefined> {
    const current = this.#submissions.get(id);
    if (!current || current.status !== "pending") return undefined;
    let createdItemId: string | undefined;
    if (decision === "approved") {
      const item = await this.createItem({ id: itemId, type: current.type, name: current.name, ...(current.code ? { code: current.code } : {}), status: "active", createdAt: now, updatedAt: now, actorRef: _actorRef });
      createdItemId = item.id;
    }
    const next = Object.freeze({ ...current, status: decision, moderatedAt: now, ...(createdItemId ? { createdItemId } : {}) });
    this.#submissions.set(id, next);
    return next;
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
