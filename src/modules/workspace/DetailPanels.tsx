import type { Route } from "next";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

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
      <CardHeader className="px-[18px] py-[18px] border-b border-border">
        <CardTitle className="text-lg mb-0">{title}</CardTitle>
      </CardHeader>
      <div className="grid grid-cols-2 sm:grid-cols-4">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className="min-h-[88px] p-4 border-r border-b border-border last:border-r-0 odd:last:border-r-0"
          >
            <span className="block mb-2 text-xs font-bold text-muted-foreground uppercase">
              {fact.label}
            </span>
            <strong className="block break-words text-[15px]">
              {fact.value || "Not set"}
            </strong>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function CompactList({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <Card className="mt-5">
      <div className="flex items-center justify-between gap-4 px-[18px] py-[14px] border-b border-border">
        <CardTitle className="text-base mb-0">{title}</CardTitle>
        <span className="text-sm font-bold text-muted-foreground">
          {rows.length}
        </span>
      </div>
      <div className="grid">
        {rows.length ? (
          rows.map((row) => (
            <article
              key={row.id}
              className="grid grid-cols-[1fr_minmax(126px,auto)] gap-4 px-4 py-[14px] border-b border-border last:border-b-0"
            >
              <div className="min-w-0 grid gap-0.5 content-center">
                {row.href ? (
                  <Link href={row.href as Route}>
                    <strong className="text-foreground text-sm">{row.title}</strong>
                  </Link>
                ) : (
                  <strong className="text-foreground text-sm">{row.title}</strong>
                )}
                <span className="text-muted-foreground text-xs">{row.subtitle}</span>
              </div>
              {row.meta ? (
                <div className="flex items-center justify-end text-muted-foreground text-xs">
                  {row.meta}
                </div>
              ) : null}
            </article>
          ))
        ) : (
          <p className="text-muted-foreground text-sm text-center py-6 m-0">
            No imported records found here yet.
          </p>
        )}
      </div>
    </Card>
  );
}
