"use client";

export default function AdminDailyStandupError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
      <p className="text-destructive text-sm font-medium">
        Failed to load daily standup answers.
      </p>
      <p className="text-muted-foreground text-xs">
        Please try again or contact support if the issue persists.
      </p>
      <button
        onClick={reset}
        className="text-sm text-primary underline underline-offset-4 hover:text-primary/80"
      >
        Try again
      </button>
    </div>
  );
}
