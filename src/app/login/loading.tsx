import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function LoginLoading() {
  return (
    <main className="min-h-svh w-[min(1160px,calc(100%_-_28px))] mx-auto grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(400px,500px)] content-start items-start gap-4 pt-[18px] pb-[42px] max-sm:w-[min(calc(100%_-_20px),720px)]">
      {/* Nav skeleton */}
      <nav
        className="col-span-full min-h-[62px] flex items-center justify-between gap-3.5 border border-border rounded-lg bg-card p-2 shadow-sm max-sm:flex-col max-sm:items-stretch"
        aria-label="Loading login"
      >
        <div className="flex items-center gap-2.5 px-2">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="h-5 w-24" />
        </div>
        <Skeleton className="h-8 w-8 rounded-md" />
      </nav>

      {/* Intro card skeleton */}
      <Card className="overflow-hidden border-border">
        <CardContent className="p-[clamp(22px,4vw,48px)]">
          <Skeleton className="h-3 w-44 mb-3" />
          <Skeleton className="h-[clamp(44px,6.4vw,92px)] w-full max-w-[640px] mb-2" />
          <Skeleton className="h-5 w-24 mb-1" />
          <Skeleton className="h-4 w-full max-w-[480px] mb-1" />
          <Skeleton className="h-4 w-full max-w-[380px] mb-4" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-7 w-40 rounded-full" />
            <Skeleton className="h-7 w-44 rounded-full" />
            <Skeleton className="h-7 w-48 rounded-full" />
          </div>
          <Skeleton className="h-4 w-28 mt-4" />
        </CardContent>
      </Card>

      {/* Login panel skeleton */}
      <Card className="self-start border-border" aria-label="Loading sign-in panel">
        <CardContent className="p-6 grid gap-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-4 w-16 mt-1" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md mt-2" />
          <Skeleton className="h-4 w-48 mx-auto mt-2" />
        </CardContent>
      </Card>

      {/* Role notes skeleton */}
      <section className="col-span-full grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <Card key={i}>
            <CardContent className="grid gap-1.5 p-3.5">
              <Skeleton className="size-4" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-28" />
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
