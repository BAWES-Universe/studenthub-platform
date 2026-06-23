import Link from "next/link";
import type { Route } from "next";
import type { PermissionSectionResult } from "@/modules/admin/permission-sections/actions";

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
      <table className="w-full">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-4 py-3 text-left text-sm font-medium">Section Name</th>
            <th className="px-4 py-3 text-left text-sm font-medium">Permission UUID</th>
            <th className="px-4 py-3 text-left text-sm font-medium">Created</th>
            <th className="px-4 py-3 text-right text-sm font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <tr
              key={section.permissionUuid}
              className="border-b last:border-0 hover:bg-muted/30"
            >
              <td className="px-4 py-3 text-sm font-medium">
                <Link
                  href={`/admin/settings/permission-sections/${section.permissionUuid}` as Route}
                  className="hover:underline"
                >
                  {section.sectionName ?? "—"}
                </Link>
              </td>
              <td className="px-4 py-3 text-sm text-muted-foreground font-mono">
                {section.permissionUuid.slice(0, 12)}...
              </td>
              <td className="px-4 py-3 text-sm text-muted-foreground">
                {new Intl.DateTimeFormat("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                }).format(section.createdAt)}
              </td>
              <td className="px-4 py-3 text-right">
                <Link
                  href={`/admin/settings/permission-sections/${section.permissionUuid}` as Route}
                  className="text-sm text-primary hover:underline"
                >
                  Edit
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
