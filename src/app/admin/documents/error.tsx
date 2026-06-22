"use client";

import { Button } from "@/components/ui/button";

import { useEffect } from "react";

export default function AdminDocumentsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("admin/documents error:", error);
  }, [error]);

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground">
        Failed to load the document generation page. Please try again.
      </p>
      <Button onClick={reset} variant="default" className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90" >Try again</Button>
    </div>
  );
}
