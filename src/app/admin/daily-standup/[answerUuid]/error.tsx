"use client";

import { Button } from "@/components/ui/button";

export default function AdminDailyStandupDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
      <p className="text-destructive text-sm font-medium">
        Failed to load daily standup answer details.
      </p>
      <p className="text-muted-foreground text-xs">
        Please try again or contact support if the issue persists.
      </p>
      <Button variant="link" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
