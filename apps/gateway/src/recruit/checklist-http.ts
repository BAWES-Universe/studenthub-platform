import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { NOTE_TYPES, checklistProgress, isRecruitId, parseChecklistItem, parseNote, type ChecklistItemFields, type ChecklistItemRow, type ChecklistProgress, type NoteFields, type NoteType } from "../../../../packages/recruit/src/index.js";
import { BAD, NOT_FOUND, UNAUTHORIZED, decodeSegment, errorPage, html, isObject, readBody, redirect, sameOrigin, sendJson, sessionCookie, when, type RecruitPageWriter, type RecruitResult } from "./http-common.js";

// Recruit R2b: checklist administration and request notes.
//   GET  /recruit/admin/checklist                 items (JSON or HTML with forms)
//   POST /recruit/admin/checklist/create          {nameEn, nameAr?, required?, sortOrder?}
//   POST /recruit/admin/checklist/<id>/update     same fields
//   POST /recruit/admin/checklist/<id>/remove
//   GET  /recruit/staff/requests/<id>/notes       notes and checklist progress (JSON or HTML)
//   POST /recruit/staff/requests/<id>/notes       {type, text, checklistItemId?, cardId?}
//   POST /recruit/staff/notes/<id>/edit           {type, text}
//   POST /recruit/staff/notes/<id>/remove

export interface RecruitChecklistStore {
  items(principalId: string): Promise<readonly ChecklistItemRow[] | null>;
  createItem(principalId: string, input: ChecklistItemFields): Promise<{ kind: "created"; itemId: string } | { kind: "not_found" }>;
  updateItem(principalId: string, itemId: string, input: ChecklistItemFields): Promise<{ kind: "updated" | "not_found" }>;
  removeItem(principalId: string, itemId: string): Promise<{ kind: "removed" | "not_found" }>;
  addNote(principalId: string, requestId: string, input: NoteFields): Promise<{ kind: "created"; noteId: string } | { kind: "updated" | "removed" | "not_found" | "item_not_found" | "card_not_found" }>;
  editNote(principalId: string, noteId: string, type: NoteType, text: string): Promise<{ kind: "created"; noteId: string } | { kind: "updated" | "removed" | "not_found" | "item_not_found" | "card_not_found" }>;
  removeNote(principalId: string, noteId: string): Promise<{ kind: "created"; noteId: string } | { kind: "updated" | "removed" | "not_found" | "item_not_found" | "card_not_found" }>;
  requestNotes(principalId: string, requestId: string): Promise<{
    title: string; items: readonly ChecklistItemRow[]; doneItemIds: readonly string[];
    notes: readonly { id: string; card_id: string | null; person_name: string | null; checklist_item_id: string | null; checklist_name: string | null; note_type: NoteType; note_text: string; author_name: string | null; created_at: string | Date; updated_at: string | Date }[];
  } | null>;
}

export interface NoteView { readonly noteId: string; readonly type: NoteType; readonly text: string; readonly cardId: string | null; readonly personName: string | null; readonly checklistItemId: string | null; readonly checklistName: string | null; readonly author: string | null; readonly createdAt: string; readonly edited: boolean }
export interface RequestNotesBody { readonly requestId: string; readonly title: string; readonly checklist: readonly ChecklistProgress[]; readonly requiredRemaining: number; readonly notes: readonly NoteView[] }
export interface ChecklistItemView { readonly itemId: string; readonly nameEn: string; readonly nameAr: string | null; readonly required: boolean; readonly sortOrder: number }

export interface RecruitChecklist {
  items(session: string | undefined): Promise<RecruitResult<{ items: readonly ChecklistItemView[] }>>;
  createItem(session: string | undefined, body: unknown): Promise<RecruitResult<{ itemId: string }>>;
  updateItem(session: string | undefined, itemId: string, body: unknown): Promise<RecruitResult<{ itemId: string }>>;
  removeItem(session: string | undefined, itemId: string): Promise<RecruitResult<{ itemId: string }>>;
  notes(session: string | undefined, requestId: string): Promise<RecruitResult<RequestNotesBody>>;
  addNote(session: string | undefined, requestId: string, body: unknown): Promise<RecruitResult<{ noteId: string }>>;
  editNote(session: string | undefined, noteId: string, body: unknown): Promise<RecruitResult<{ noteId: string }>>;
  removeNote(session: string | undefined, noteId: string): Promise<RecruitResult<{ noteId: string }>>;
}

const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();
const itemView = (row: ChecklistItemRow): ChecklistItemView => ({ itemId: row.id, nameEn: row.name_en, nameAr: row.name_ar, required: row.required, sortOrder: row.sort_order });

export function createRecruitChecklist(p: { sessions: Pick<SessionStore, "get">; store: RecruitChecklistStore }): RecruitChecklist {
  const principal = async (s: string | undefined) => (s ? (await p.sessions.get(s))?.personId : undefined);
  const write = <T>(r: { kind: string }, ok: string, body: T): RecruitResult<T> =>
    r.kind === ok ? { status: 200, body } : r.kind === "not_found" ? NOT_FOUND : { status: 409, body: { error: r.kind } };
  return {
    async items(s) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      const rows = await p.store.items(id);
      return rows ? { status: 200, body: { items: rows.map(itemView) } } : NOT_FOUND;
    },
    async createItem(s, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      const fields = parseChecklistItem(body);
      if (!fields) return BAD;
      const r = await p.store.createItem(id, fields);
      return r.kind === "created" ? { status: 200, body: { itemId: r.itemId } } : NOT_FOUND;
    },
    async updateItem(s, itemId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(itemId)) return NOT_FOUND;
      const fields = parseChecklistItem(body);
      if (!fields) return BAD;
      return write(await p.store.updateItem(id, itemId.toLowerCase(), fields), "updated", { itemId: itemId.toLowerCase() });
    },
    async removeItem(s, itemId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(itemId)) return NOT_FOUND;
      return write(await p.store.removeItem(id, itemId.toLowerCase()), "removed", { itemId: itemId.toLowerCase() });
    },
    async notes(s, requestId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const r = await p.store.requestNotes(id, requestId.toLowerCase());
      if (!r) return NOT_FOUND;
      const progress = checklistProgress(r.items, new Set(r.doneItemIds));
      return { status: 200, body: {
        requestId: requestId.toLowerCase(), title: r.title, checklist: progress.steps, requiredRemaining: progress.requiredRemaining,
        notes: r.notes.map((n) => ({ noteId: n.id, type: n.note_type, text: n.note_text, cardId: n.card_id, personName: n.person_name, checklistItemId: n.checklist_item_id, checklistName: n.checklist_name, author: n.author_name, createdAt: iso(n.created_at), edited: iso(n.updated_at) !== iso(n.created_at) })),
      } };
    },
    async addNote(s, requestId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId)) return NOT_FOUND;
      const fields = parseNote(body);
      if (!fields) return BAD;
      const r = await p.store.addNote(id, requestId.toLowerCase(), fields);
      return r.kind === "created" ? { status: 200, body: { noteId: r.noteId } } : r.kind === "not_found" ? NOT_FOUND : { status: 409, body: { error: r.kind } };
    },
    async editNote(s, noteId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(noteId)) return NOT_FOUND;
      const fields = isObject(body) && Object.keys(body).every((k) => k === "type" || k === "text") ? parseNote(body) : undefined;
      if (!fields) return BAD;
      return write(await p.store.editNote(id, noteId.toLowerCase(), fields.type, fields.text), "updated", { noteId: noteId.toLowerCase() });
    },
    async removeNote(s, noteId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(noteId)) return NOT_FOUND;
      return write(await p.store.removeNote(id, noteId.toLowerCase()), "removed", { noteId: noteId.toLowerCase() });
    },
  };
}

const TYPE_LABEL: Readonly<Record<NoteType, string>> = { internal_note: "Internal note", phone_call: "Phone call", email: "Email", meeting: "Meeting", interview: "Interview", task: "Task" };

export function renderChecklistAdmin(items: readonly ChecklistItemView[]): string {
  const fields = (item?: ChecklistItemView) => `<label>Name <input name="nameEn" required maxlength="100" value="${html(item?.nameEn ?? "")}"></label> <label>Arabic name <input name="nameAr" maxlength="100" dir="rtl" value="${html(item?.nameAr ?? "")}"></label> <label><input type="checkbox" name="required"${item?.required ? " checked" : ""}> Required</label> <label>Order <input name="sortOrder" type="number" min="0" max="1000" value="${item?.sortOrder ?? 0}"></label>`;
  const rows = items.map((item) => `<li><form method="post" action="/recruit/admin/checklist/${html(item.itemId)}/update">${fields(item)} <button class="button" type="submit">Save</button></form><form method="post" action="/recruit/admin/checklist/${html(item.itemId)}/remove"><button class="button" type="submit">Remove</button></form></li>`).join("");
  return `<main id="main" class="profile-main"><h1>Request checklist<span class="accent">.</span></h1>${rows ? `<ol>${rows}</ol>` : "<p>No steps yet.</p>"}<h2>Add a step</h2><form method="post" action="/recruit/admin/checklist/create">${fields()} <button class="button primary" type="submit">Add</button></form></main>`;
}

export function renderRequestNotes(body: RequestNotesBody, cards: readonly { cardId: string; name: string | null }[] = []): string {
  const steps = body.checklist.map((s) => `<li>${s.done ? "✓" : "○"} ${html(s.nameEn)}${s.nameAr ? ` <span dir="rtl" lang="ar">${html(s.nameAr)}</span>` : ""}${s.required ? " (required)" : ""}</li>`).join("");
  const notes = body.notes.map((n) => `<li><p><strong>${html(TYPE_LABEL[n.type])}</strong>${n.checklistName ? ` · ${html(n.checklistName)}` : ""}${n.personName ? ` · ${html(n.personName)}` : ""} · <time datetime="${html(n.createdAt)}">${html(when(n.createdAt))}</time>${n.author ? ` by ${html(n.author)}` : ""}${n.edited ? " (edited)" : ""}</p><p style="white-space:pre-wrap">${html(n.text)}</p><form method="post" action="/recruit/staff/notes/${html(n.noteId)}/remove"><input type="hidden" name="requestId" value="${html(body.requestId)}"><button class="button" type="submit">Remove</button></form></li>`).join("");
  const select = (name: string, options: readonly [string, string][], blank: string) => `<select id="${name}" name="${name}"><option value="">${html(blank)}</option>${options.map(([v, l]) => `<option value="${html(v)}">${html(l)}</option>`).join("")}</select>`;
  return `<main id="main" class="profile-main"><h1>${html(body.title)}: notes<span class="accent">.</span></h1><section><h2>Checklist</h2>${steps ? `<ul>${steps}</ul><p>${body.requiredRemaining} required step${body.requiredRemaining === 1 ? "" : "s"} left.</p>` : "<p>No checklist steps are set up.</p>"}</section><section><h2>Add a note</h2><form method="post" action="/recruit/staff/requests/${html(body.requestId)}/notes"><p><label for="type">Type</label> <select id="type" name="type">${NOTE_TYPES.map((t) => `<option value="${t}">${html(TYPE_LABEL[t])}</option>`).join("")}</select></p><p><label for="checklistItemId">Checklist step</label> ${select("checklistItemId", body.checklist.map((s) => [s.itemId, s.nameEn]), "None")}</p>${cards.length ? `<p><label for="cardId">Person</label> ${select("cardId", cards.map((c) => [c.cardId, c.name ?? "Unnamed person"]), "The whole request")}</p>` : ""}<p><label for="text">Note</label><br><textarea id="text" name="text" required maxlength="5000"></textarea></p><button class="button primary" type="submit">Add note</button></form></section><section><h2>Notes</h2>${notes ? `<ol>${notes}</ol>` : "<p>No notes yet.</p>"}</section><p><a class="text-link" href="/recruit/staff/requests/${html(body.requestId)}">Back to the pipeline</a></p></main>`;
}

const ADMIN = "/recruit/admin/checklist", CREATE = "/recruit/admin/checklist/create";
const ITEM = /^\/recruit\/admin\/checklist\/([^/]+)\/(update|remove)$/, NOTES = /^\/recruit\/staff\/requests\/([^/]+)\/notes$/, NOTE = /^\/recruit\/staff\/notes\/([^/]+)\/(edit|remove)$/;

export async function handleRecruitChecklist(req: IncomingMessage, res: ServerResponse, s: RecruitChecklist | undefined, origin: string | undefined, write: RecruitPageWriter, wantsHtml: boolean): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const item = ITEM.exec(path), notes = NOTES.exec(path), note = NOTE.exec(path);
  if (path !== ADMIN && path !== CREATE && !item && !notes && !note) return false;
  const back = notes ? { href: `/recruit/staff/requests/${encodeURIComponent(decodeSegment(notes))}`, label: "Back to the pipeline" } : { href: "/workspace", label: "Back to your workspace" };
  try {
    if (!s || !origin) { wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } }); return true; }
    const session = sessionCookie(req.headers.cookie);
    if (req.method === "GET" && (path === ADMIN || notes)) {
      if (path === ADMIN) {
        const r = await s.items(session);
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, "Request checklist", renderChecklistAdmin(r.body.items)); else errorPage(write, r.status, back);
      } else {
        const r = await s.notes(session, decodeSegment(notes!));
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, `${r.body.title}: notes`, renderRequestNotes(r.body)); else errorPage(write, r.status, back);
      }
      return true;
    }
    if (req.method !== "POST" || path === ADMIN) { sendJson(res, NOT_FOUND); return true; }
    if (!sameOrigin(req, origin)) { req.resume(); sendJson(res, { status: 403, body: { error: "origin_rejected" } }); return true; }
    const body = await readBody(req, 16384);
    if (!body) { sendJson(res, BAD); return true; }
    const value = body.value as Record<string, string>;
    let r: RecruitResult<unknown>, location = ADMIN;
    if (path === CREATE) r = await s.createItem(session, body.value);
    else if (item) r = item[2] === "update" ? await s.updateItem(session, decodeSegment(item), body.value) : await s.removeItem(session, decodeSegment(item));
    else if (notes) {
      const requestId = decodeSegment(notes);
      const payload = body.form ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== "")) : body.value;
      r = await s.addNote(session, requestId, payload);
      location = `/recruit/staff/requests/${encodeURIComponent(requestId)}/notes`;
    } else {
      const { requestId, ...rest } = body.form ? value : { requestId: undefined };
      r = note![2] === "edit" ? await s.editNote(session, decodeSegment(note!), body.form ? rest : body.value) : await s.removeNote(session, decodeSegment(note!));
      location = isRecruitId(requestId) ? `/recruit/staff/requests/${requestId.toLowerCase()}/notes` : "/recruit/staff/requests";
    }
    if (body.form) { if (r.status === 200) redirect(res, location); else errorPage(write, r.status, back); }
    else sendJson(res, r);
  } catch {
    if (!res.headersSent) wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } });
    else res.destroy();
  }
  return true;
}
