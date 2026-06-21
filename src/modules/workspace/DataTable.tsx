import type { ReactNode } from "react";
import type { Route } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";

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
  rowHref
}: {
  title: string;
  description: string;
  rows: T[];
  columns: DataTableColumn<T>[];
  rowHref?: (row: T) => Route;
}) {
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5 border-b border-border">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold mb-0.5">{title}</h2>
          <p className="text-sm text-muted-foreground mb-0">{description}</p>
        </div>
        <span className="text-sm font-bold text-muted-foreground shrink-0">{rows.length} shown</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className="text-left text-xs font-bold text-muted-foreground uppercase px-4 py-3 border-b border-border">
                  {column.label}
                </th>
              ))}
              {rowHref ? <th className="px-4 py-3 border-b border-border" aria-label="Open record" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-b-0 hover:bg-muted/30 transition-colors">
                  {columns.map((column) => (
                    <td key={column.key} className="px-4 py-3 align-top text-sm">
                      {column.render(row)}
                    </td>
                  ))}
                  {rowHref ? (
                    <td className="px-4 py-3 align-middle text-right">
                      <Link
                        href={rowHref(row)}
                        className="text-blue-zendesk text-sm font-semibold hover:underline no-underline"
                      >
                        Open &rarr;
                      </Link>
                    </td>
                  ) : null}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length + (rowHref ? 1 : 0)} className="p-0">
                  <div className="grid gap-2 justify-items-center text-center py-12 px-6">
                    <strong className="text-foreground text-[15px]">No records found</strong>
                    <span className="text-muted-foreground text-sm max-w-[380px]">
                      This view is connected to the prod clone, but this account has no matching rows yet.
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
