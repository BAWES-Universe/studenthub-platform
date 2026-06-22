import { Skeleton } from "@/components/ui/skeleton";

export default function AdminExpenseLoading() {
  return (
    <div className="px-[22px] py-[18px] grid gap-3">
      {/* Header */}
      <div className="flex justify-between items-center mb-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>

      {/* Filter/search bar */}
      <div className="flex gap-2.5 mb-1">
        <Skeleton className="h-9 flex-1 rounded-lg" />
        <Skeleton className="h-9 w-24 rounded-lg" />
      </div>

      {/* Table rows */}
      <div className="grid gap-px">
        {/* Header row */}
        <div className="grid grid-cols-[1fr_1fr_120px_140px_140px_120px] gap-3 px-[14px] py-[10px]">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-16" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_1fr_120px_140px_140px_120px] gap-3 px-[14px] py-3 border-t border-border"
          >
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
