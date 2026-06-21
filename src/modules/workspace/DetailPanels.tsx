import type { Route } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
      <CardHeader className="border-b border-border px-[18px] py-[18px]">
        <CardTitle className="m-0 text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-2 md:grid-cols-4">
          {facts.map((fact) => (
            <div
              className="min-h-[88px] p-4 border-r border-b border-border last:border-r-0 [&:nth-child(4n)]:border-r-0"
              key={fact.label}
            >
              <span className="block mb-2 text-muted-foreground text-xs font-extrabold uppercase tracking-wide">
                {fact.label}
              </span>
              <strong className="block break-words text-[15px]">
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
    <Card className="mt-5">
      <CardHeader className="flex flex-row items-center justify-between gap-4 px-[18px] py-[18px] border-b border-border">
        <CardTitle className="m-0 text-lg">{title}</CardTitle>
        <span className="min-w-[30px] min-h-[30px] inline-flex items-center justify-center text-blue-600 border border-blue-200 bg-blue-50 font-bold text-sm rounded">
          {rows.length}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length ? (
          <div className="grid">
            {rows.map((row) => (
              <article
                className="grid grid-cols-[1fr_minmax(126px,auto)] gap-4 px-[18px] py-3.5 border-b border-border last:border-b-0 min-h-[72px]"
                key={row.id}
              >
                <div className="min-w-0 grid content-center gap-1.5">
                  {row.href ? (
                    <Link href={row.href as Route} className="no-underline">
                      <strong className="text-foreground">{row.title}</strong>
                    </Link>
                  ) : (
                    <strong className="text-foreground">{row.title}</strong>
                  )}
                  <span className="text-muted-foreground text-sm">{row.subtitle}</span>
                </div>
                <div className="flex items-center justify-end">
                  {row.meta ? (
                    <span className="text-muted-foreground text-sm">{row.meta}</span>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="grid gap-1.5 p-4 text-muted-foreground">
            <strong className="text-foreground text-[15px]">No items here</strong>
            <span className="text-sm">
              The imported database did not return rows for this panel.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
