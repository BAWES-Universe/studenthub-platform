import { Skeleton } from "@/components/ui/skeleton";

export default function LoadingPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
      <Skeleton className="size-8 rounded-full" />
      <Skeleton className="h-4 w-24" />
    </div>
  );
}
