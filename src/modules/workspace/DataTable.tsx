import type { ReactNode } from "react";
import type { Route } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type DataTableColumn<T> = {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
};

export function DataTable<T extends { id: string | number }>({
  title,
  description,
  rows,
  columns,
  rowHref,
}: {
  title: string;
  description: string;
  rows: T[];
  columns: DataTableColumn<T>[];
  rowHref?: (row: T) => Route;
}) {
  return (
    <Card className="mt-5 shadow-[0_12px_44px_rgba(16,24,40,0.05)]">
      <div className="flex items-center justify-between gap-4.5 min-h-[76px] px-[18px] py-[18px] border-b border-border">
        <div>
          <CardTitle className="mb-0 text-lg">{title}</CardTitle>
          <CardDescription className="mt-0.5">{description}</CardDescription>
        </div>
        <span className="shrink-0 text-sm font-bold text-muted-foreground">
          {rows.length} shown
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[860px]">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className="text-left text-xs font-bold text-muted-foreground uppercase px-4 py-3 border-b border-border"
                >
                  {column.label}
                </th>
              ))}
              {rowHref ? (
                <th
                  className="w-[1%] whitespace-nowrap px-4 py-3 border-b border-border"
                  aria-label="Open record"
                />
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.id}>
                  {columns.map((column) => (
                    <td
                      data-label={column.label}
                      key={column.key}
                      className="text-sm px-4 py-[13px] border-b border-border last:border-b-0 align-top"
                    >
                      {column.render(row)}
                    </td>
                  ))}
                  {rowHref ? (
                    <td className="w-[1%] whitespace-nowrap px-4 py-[13px] border-b border-border align-top">
                      <Link
                        href={rowHref(row)}
                        className={cn(
                          buttonVariants({ variant: "outline", size: "sm" }),
                          "gap-1.5 no-underline",
                        )}
                      >
                        Open
                        <ArrowRight className="size-3" />
                      </Link>
                    </td>
                  ) : null}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={columns.length + (rowHref ? 1 : 0)}
                  className="p-0"
                >
                  <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                    <strong className="text-sm text-foreground">
                      No records found
                    </strong>
                    <span className="text-sm text-muted-foreground mt-1 max-w-[400px]">
                      This view is connected to the prod clone, but this account
                      has no matching rows yet.
                    </span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
