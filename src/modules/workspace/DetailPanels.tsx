import type { Route } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";

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
    <Card className="overflow-hidden">
      <h2 className="m-0 px-4 py-3.5 border-b border-border text-lg font-semibold">{title}</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
        {facts.map((fact) => (
          <div key={fact.label} className="min-h-[88px] p-4 border-r border-b border-border last:border-r-0 odd:last:border-r-0 [&:nth-child(4n)]:border-r-0">
            <span className="block mb-2 text-xs font-bold text-muted-foreground uppercase tracking-wide">{fact.label}</span>
            <strong className="block break-words text-[15px]">{fact.value || "Not set"}</strong>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function CompactList({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5 border-b border-border">
        <h2 className="text-lg font-semibold mb-0">{title}</h2>
        <span className="min-w-[28px] min-h-[28px] inline-flex items-center justify-center text-blue-zendesk border border-blue-zendesk/20 bg-blue-zendesk/5 font-bold text-xs rounded">{rows.length}</span>
      </div>
      <div className="grid">
        {rows.length ? (
          rows.map((row) => (
            <article key={row.id} className="min-h-[64px] grid grid-cols-[1fr_minmax(120px,auto)] gap-4 px-4 py-3 border-b border-border last:border-b-0">
              <div className="min-w-0 grid content-center gap-1.5">
                {row.href ? (
                  <Link href={row.href as Route} className="text-foreground no-underline hover:text-blue-zendesk hover:underline hover:underline-offset-[3px]">
                    <strong>{row.title}</strong>
                  </Link>
                ) : (
                  <strong className="text-foreground">{row.title}</strong>
                )}
                <span className="text-muted-foreground text-sm">{row.subtitle}</span>
              </div>
              <div className="flex items-center justify-end">
                {row.meta ? <span className="text-muted-foreground text-sm">{row.meta}</span> : null}
              </div>
            </article>
          ))
        ) : (
          <div className="grid gap-1.5 p-4 text-muted-foreground">
            <strong className="text-foreground text-[15px]">No records found</strong>
            <span className="text-sm">No imported records found here yet.</span>
          </div>
        )}
      </div>
    </Card>
  );
}
