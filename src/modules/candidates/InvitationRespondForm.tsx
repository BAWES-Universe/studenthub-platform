"use client";

import { useActionState } from "react";
import { respondToInvitation } from "@/modules/candidates/actions";
import { Button } from "@/components/ui/button";

export function InvitationRespondForm({
  invitationUuid,
  currentStatus,
}: {
  invitationUuid: string;
  currentStatus: number;
}) {
  const [state, action, pending] = useActionState(respondToInvitation, { error: "" });

  if (currentStatus === 1 || currentStatus === 2) {
    return (
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold mb-0">Response</h2>
        <p className="text-sm text-muted-foreground mb-0">
          You have already {currentStatus === 1 ? "accepted" : "rejected"} this invitation.
        </p>
      </section>
    );
  }

  return (
    <form action={action} className="grid gap-3">
      <h2 className="text-lg font-semibold mb-0">Respond to Invitation</h2>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <input type="hidden" name="invitationUuid" value={invitationUuid} />

      <div className="flex gap-2">
        <Button type="submit" name="action" value="accept" disabled={pending}>
          {pending ? "Sending..." : "Accept invitation"}
        </Button>
        <Button type="submit" name="action" value="reject" variant="destructive" disabled={pending}>
          {pending ? "Sending..." : "Reject invitation"}
        </Button>
      </div>
    </form>
  );
}
