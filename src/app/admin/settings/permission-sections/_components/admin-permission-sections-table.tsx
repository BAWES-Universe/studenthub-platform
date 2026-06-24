import Link from "next/link";
import type { Route } from "next";
import type { PermissionSectionResult } from "@/modules/admin/permission-sections/actions";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

type Props = {
  sections: PermissionSectionResult[];
};

export function AdminPermissionSectionsTable({ sections }: Props) {
  if (sections.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-md border border-dashed">
        <p className="text-muted-foreground text-sm">No permission sections found.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Section Name</TableHead>
            <TableHead>Permission UUID</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sections.map((section) => (
            <TableRow key={section.permissionUuid}>
              <TableCell className="font-medium">
                <Link
                  href={`/admin/settings/permission-sections/${section.permissionUuid}` as Route}
                  className="hover:underline"
                >
                  {section.sectionName ?? "—"}
                </Link>
              </TableCell>
              <TableCell className="font-mono text-muted-foreground">
                {section.permissionUuid.slice(0, 12)}...
              </TableCell>
              <TableCell className="text-muted-foreground">
                {new Intl.DateTimeFormat("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                }).format(section.createdAt)}
              </TableCell>
              <TableCell className="text-right">
                <Link
                  href={`/admin/settings/permission-sections/${section.permissionUuid}` as Route}
                  className="text-sm text-primary hover:underline"
                >
                  Edit
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
