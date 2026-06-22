export default function Loading() {
  return (
    <div className="p-6 space-y-6">
      <div className="h-8 w-48 bg-muted animate-pulse rounded" />
      <div className="h-4 w-96 bg-muted animate-pulse rounded" />
      <div className="h-10 w-full max-w-md bg-muted animate-pulse rounded" />
      <div className="h-64 w-full bg-muted animate-pulse rounded-lg" />
    </div>
  );
}
