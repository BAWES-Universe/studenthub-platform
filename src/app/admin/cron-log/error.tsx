"use client";

import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-xl font-bold text-destructive">Something went wrong</h2>
      <p className="text-sm text-muted-foreground">
        Could not load cron log data.
      </p>
      <p className="max-w-lg text-xs text-muted-foreground font-mono">
        {error.message}
      </p>
      <Button variant="link" onClick={() => reset()}>
        Try again
      </Button>
    </div>
  );
}
