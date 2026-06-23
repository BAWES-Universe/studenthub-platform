import type { Route } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Fact = {
  label: string;
  value: string | number | null | undefined;
};

type Row = {
  id: string | number;
  title: string;
  subtitle: string;
  meta?: string;
  href?: string;
};

export function FactPanel({ title, facts }: { title: string; facts: Fact[] }) {
  return (
    <Card className="mt-5">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-base font-bold text-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {facts.map((fact) => (
            <div
              key={fact.label}
              className="min-h-[88px] p-4 border-r border-border border-b border-border last:border-r-0 odd:last:border-r-0 [&:nth-child(4n)]:border-r-0"
            >
              <span className="block mb-2 text-xs font-extrabold uppercase text-muted-foreground">
                {fact.label}
              </span>
              <strong className="block break-words text-sm text-foreground">
                {fact.value ?? "Not set"}
              </strong>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function CompactList({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <Card className="h-fit">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5 border-b border-border">
        <h2 className="text-base font-bold text-foreground m-0">{title}</h2>
        <span className="min-w-[30px] min-h-[30px] inline-flex items-center justify-center text-[#1f73b7] border border-blue-200 bg-blue-50 font-bold text-sm rounded">
          {rows.length}
        </span>
      </div>
      <div className="grid">
        {rows.length ? (
          rows.map((row) => (
            <article
              key={row.id}
              className="min-h-[72px] grid grid-cols-[1fr_minmax(126px,auto)] gap-4 px-4 py-3.5 border-b border-border last:border-b-0"
            >
              <div className="min-w-0 grid gap-1.5 content-center">
                {row.href ? (
                  <Link href={row.href as Route} className="text-foreground no-underline hover:text-[#1f73b7] hover:underline hover:underline-offset-[3px]">
                    <strong>{row.title}</strong>
                  </Link>
                ) : (
                  <strong className="text-foreground">{row.title}</strong>
                )}
                <span className="text-muted-foreground text-sm">{row.subtitle}</span>
              </div>
              {row.meta ? (
                <div className="flex items-center justify-end">
                  <span className="text-muted-foreground text-sm">{row.meta}</span>
                </div>
              ) : null}
            </article>
          ))
        ) : (
          <div className="grid gap-1.5 p-4 text-center">
            <strong className="text-foreground text-[15px]">No items here</strong>
            <span className="text-muted-foreground text-sm">No imported records found here yet.</span>
          </div>
        )}
      </div>
    </Card>
  );
}
