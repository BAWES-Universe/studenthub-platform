import type { ReactNode } from "react";
import type { Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
    <Card className="mt-5">
      <CardHeader className="flex flex-row items-center justify-between gap-4 py-4">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <span className="text-sm font-bold text-muted-foreground shrink-0">
          {rows.length} shown
        </span>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.key}>{column.label}</TableHead>
              ))}
              {rowHref ? <TableHead aria-label="Open record" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  {columns.map((column) => (
                    <TableCell key={column.key}>
                      {column.render(row)}
                    </TableCell>
                  ))}
                  {rowHref ? (
                    <TableCell className="w-[1%] whitespace-nowrap">
                      <Button variant="outline" size="sm" asChild>
                        <Link href={rowHref(row)}>Open</Link>
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (rowHref ? 1 : 0)}
                  className="text-center py-12"
                >
                  <div className="grid gap-1.5 justify-items-center text-muted-foreground">
                    <strong className="text-foreground text-[15px]">
                      No records found
                    </strong>
                    <span className="text-sm">
                      This view is connected to the prod clone, but this account
                      has no matching rows yet.
                    </span>
                  </div>
              </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
