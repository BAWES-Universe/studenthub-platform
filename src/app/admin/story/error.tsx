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
    <div className="flex flex-col items-center justify-center py-24 gap-4">
      <span className="text-4xl" aria-hidden="true">⚠️</span>
      <h2 className="text-xl font-bold text-foreground">
        Something went wrong
      </h2>
      <p className="text-sm max-w-md text-center text-muted-foreground">
        {error.message ?? "An unexpected error occurred while loading the stories page."}
      </p>
      {error.digest ? <small className="text-muted-foreground">Error ID: {error.digest}</small> : null}
      <Button variant="outline" onClick={reset} className="mt-2">
        Try again
      </Button>
    </div>
  );
}