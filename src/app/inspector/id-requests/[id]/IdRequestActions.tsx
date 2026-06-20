"use client";

import { useActionState, useState } from "react";
import { approveIdRequest, rejectIdRequest } from "@/modules/candidates/actions";
import { Button } from "@/components/ui/button";

export function IdRequestActions({
  requestUuid,
  currentStatus,
}: {
  requestUuid: string;
  currentStatus: string | null | undefined;
}) {
  const [showReject, setShowReject] = useState(false);
  const [approveState, approveAction, approvePending] = useActionState(approveIdRequest, { error: "" });
  const [rejectState, rejectAction, rejectPending] = useActionState(rejectIdRequest, { error: "" });

  if (currentStatus !== "pending") return null;

  return (
    <div className="flex flex-col gap-4 mt-4">
      <form
        action={approveAction}
        onSubmit={(e) => {
          if (!window.confirm("Approve this ID verification request? All candidates in the batch will be notified.")) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="requestUuid" value={requestUuid} />
        <Button type="submit" disabled={approvePending}>
          {approvePending ? "Approving..." : "Approve request"}
        </Button>
        {approveState.error && (
          <p className="text-destructive text-sm mt-1">{approveState.error}</p>
        )}
      </form>

      <form action={rejectAction}>
        <input type="hidden" name="requestUuid" value={requestUuid} />
        {!showReject ? (
          <Button type="button" variant="destructive" onClick={() => setShowReject(true)}>
            Reject request
          </Button>
        ) : (
          <>
            <label>
              <span>Rejection reason</span>
              <textarea
                name="reason"
                rows={3}
                required
                minLength={10}
                maxLength={500}
                placeholder="Explain why this ID verification request is being rejected (min 10 characters)..."
                className="border border-border rounded-lg p-2 text-sm w-full mt-1"
              />
            </label>
            {rejectState.error && (
              <p className="text-destructive text-sm mt-1">{rejectState.error}</p>
            )}
            <div className="flex gap-2 mt-2">
              <Button type="submit" variant="destructive" disabled={rejectPending}>
                {rejectPending ? "Rejecting..." : "Confirm rejection"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setShowReject(false)} disabled={rejectPending}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
