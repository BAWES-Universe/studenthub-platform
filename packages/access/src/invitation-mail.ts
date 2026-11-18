/**
 * Access lane A2: how an invitation link reaches the invitee. No email
 * provider is wired yet (the comms lane's outbox lands it), so the default
 * sends nothing and the inviting owner copies the link shown to them once.
 */
export interface InvitationMessage {
  readonly to: string;
  readonly organizationName: string;
  readonly role: string;
  readonly link: string;
  readonly expiresAt: string;
}

export interface InvitationMailer {
  /** True when the message was handed to a sender; false when nothing was sent. */
  send(message: InvitationMessage): Promise<boolean>;
}

export const NO_SEND_INVITATION_MAILER: InvitationMailer = Object.freeze({ async send() { return false; } });

/** A mailer that records messages instead of sending them, for tests and previews. */
export function recordingInvitationMailer(): InvitationMailer & { readonly sent: InvitationMessage[] } {
  const sent: InvitationMessage[] = [];
  return { sent, async send(message) { sent.push(message); return true; } };
}
