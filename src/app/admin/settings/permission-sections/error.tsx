"use client";

import { Button } from "@/components/ui/button";

export default function AdminPermissionSectionsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="text-sm text-muted-foreground">
        {error.message ?? "Failed to load permission sections."}
      </p>
      <Button variant="link" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
