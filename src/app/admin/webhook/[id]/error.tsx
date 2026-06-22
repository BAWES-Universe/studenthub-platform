"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-8 text-center">
      <h2 className="text-lg font-semibold text-destructive">Something went wrong!</h2>
      <p className="text-sm text-muted-foreground mt-2">{error.message}</p>
      <button
        onClick={reset}
        className="mt-4 text-sm text-primary underline"
      >
        Try again
      </button>
    </div>
  );
}
