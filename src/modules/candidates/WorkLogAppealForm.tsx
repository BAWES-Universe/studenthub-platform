"use client";

import { useActionState } from "react";
import { appealWorkLog } from "@/modules/candidates/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function WorkLogAppealForm({ workLogUuid }: { workLogUuid: string }) {
  const [state, action, pending] = useActionState(appealWorkLog, { error: "" });

  return (
    <form action={action} className="grid gap-3">
      <h2 className="text-lg font-semibold mb-0">Appeal this Work Log</h2>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

      <input type="hidden" name="workLogUuid" value={workLogUuid} />

      <div className="grid gap-1.5">
        <Label htmlFor="reason">Reason for appeal</Label>
        <Textarea
          id="reason"
          name="reason"
          rows={4}
          placeholder="Explain why this work log needs review..."
          required
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Submitting..." : "Submit appeal"}
        </Button>
      </div>
    </form>
  );
}
