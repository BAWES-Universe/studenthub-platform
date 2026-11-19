/**
 * Staff messages and document requests to a person.
 *
 * Legacy: `CandidateStaffNotificationService` (types 12 profile photo request, 13 civil ID
 * request, 14 free-text staff message). A repeat with the same send key for the same
 * person and kind returns the first message as `already_sent` and writes nothing, as legacy
 * does even when the text differs; the same key for another person or kind is refused. Legacy sends no email, SMS or
 * push for these, so neither does this service. The person reads them in their
 * notifications feed, rendered at read time from the stored message.
 */
export const STAFF_MESSAGE_KINDS = Object.freeze(["profile_photo_request", "civil_id_request", "message"] as const);
export type StaffMessageKind = (typeof STAFF_MESSAGE_KINDS)[number];
/** Legacy limit (`mb_strlen($message) > 1000`). */
export const STAFF_MESSAGE_BODY_MAX = 1000;
/** Legacy send keys are UUIDs, compared lower-cased (`normalizeSendKey`). */
const SEND_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface StaffMessageInput {
  readonly recipientPrincipalId: string;
  readonly kind: string;
  readonly body?: string | null;
  readonly sendKey: string;
}
export interface StaffMessageDraft {
  readonly recipientPrincipalId: string;
  readonly senderPrincipalId: string;
  readonly kind: StaffMessageKind;
  readonly body: string | null;
  readonly sendKey: string;
}
export type StaffMessageStoreResult =
  | { readonly status: "sent" | "already_sent"; readonly id: string }
  | { readonly status: "send_key_conflict" | "recipient_not_found" };
export interface StaffMessageStore {
  /** Writes the message and the recipient's feed entry in one transaction. */
  send(draft: StaffMessageDraft): Promise<StaffMessageStoreResult>;
}
export interface StaffMessageAuthority {
  /** True only for StudentHub staff (operator staff or admin grant). */
  isStaff(principalId: string): Promise<boolean>;
}
export type StaffMessageInvalid = "kind" | "body" | "send_key" | "recipient";
export type StaffMessageResult =
  | StaffMessageStoreResult
  | { readonly status: "forbidden" }
  | { readonly status: "invalid"; readonly field: StaffMessageInvalid };

export function isStaffMessageKind(value: unknown): value is StaffMessageKind {
  return typeof value === "string" && (STAFF_MESSAGE_KINDS as readonly string[]).includes(value);
}

/** Closed validation: a document request carries no body, a message carries 1 to 1000 characters. */
export function validateStaffMessage(
  senderPrincipalId: string,
  input: StaffMessageInput,
): StaffMessageDraft | { readonly field: StaffMessageInvalid } {
  if (!isStaffMessageKind(input.kind)) return { field: "kind" };
  if (typeof input.recipientPrincipalId !== "string" || !PRINCIPAL.test(input.recipientPrincipalId)) return { field: "recipient" };
  if (typeof input.sendKey !== "string" || !SEND_KEY.test(input.sendKey)) return { field: "send_key" };
  const sendKey = input.sendKey.toLowerCase();
  if (input.kind === "message") {
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (body.length < 1 || [...body].length > STAFF_MESSAGE_BODY_MAX) return { field: "body" };
    return { recipientPrincipalId: input.recipientPrincipalId, senderPrincipalId, kind: input.kind, body, sendKey };
  }
  if (input.body !== undefined && input.body !== null && input.body !== "") return { field: "body" };
  return { recipientPrincipalId: input.recipientPrincipalId, senderPrincipalId, kind: input.kind, body: null, sendKey };
}

export class StaffMessagesService {
  constructor(
    private readonly store: StaffMessageStore,
    private readonly authority: StaffMessageAuthority,
  ) {}

  async send(senderPrincipalId: string, input: StaffMessageInput): Promise<StaffMessageResult> {
    if (!(await this.authority.isStaff(senderPrincipalId))) return { status: "forbidden" };
    const draft = validateStaffMessage(senderPrincipalId, input);
    if ("field" in draft) return { status: "invalid", field: draft.field };
    return this.store.send(draft);
  }
}

/** The person-facing line for a stored staff message, built at read time. */
export function renderStaffMessage(kind: StaffMessageKind, body: string | null): { readonly text: string; readonly href: string } {
  switch (kind) {
    case "profile_photo_request":
      return { text: "StudentHub asked you to add a profile photo.", href: "/profile/documents" };
    case "civil_id_request":
      return { text: "StudentHub asked you to add your civil ID.", href: "/profile/civil-id" };
    case "message":
      return { text: `Message from StudentHub: ${body ?? ""}`, href: "/notifications" };
  }
}
