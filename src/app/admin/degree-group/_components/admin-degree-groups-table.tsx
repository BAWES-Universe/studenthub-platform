"use client";

import { useActionState, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

import type { SessionUser } from "@/modules/auth/types";
import type { DegreeGroupListItem } from "../schemas";
import { createDegreeGroup, updateDegreeGroup, deleteDegreeGroup } from "../actions";

type Props = {
  session: SessionUser;
  degreeGroups: DegreeGroupListItem[];
};

export function AdminDegreeGroupsTable({ session, degreeGroups }: Props) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin settings"
      title="Manage degree groups — organize degree classifications across the system."
      metrics={[
        { label: "Total degree groups", value: degreeGroups.length, note: "Degree groups in the system" },
      ]}
    >
      <Card className="mb-6">
        <CardContent className="p-5">
          <h3 className="text-sm font-semibold mb-3 text-foreground">Add degree group</h3>
          <CreateDegreeGroupForm onSuccess={() => router.refresh()} />
        </CardContent>
      </Card>

      <DataTable
        title="Degree Groups"
        description="All degree groups. Click a row to edit or delete."
        rows={degreeGroups.map((g) => ({ ...g, id: g.degree_group_uuid }))}
        rowHref={undefined}
        columns={[
          {
            key: "name_en",
            label: "English name",
            render: (row) =>
              editingId === row.degree_group_uuid ? (
                <EditDegreeGroupForm
                  row={row}
                  onDone={() => { setEditingId(null); router.refresh(); }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <button
                  type="button"
                  className="text-sm hover:underline text-primary"
                  onClick={() => setEditingId(row.degree_group_uuid)}
                >
                  {row.degree_group_name_en}
                </button>
              ),
          },
          {
            key: "name_ar",
            label: "Arabic name",
            render: (row) => row.degree_group_name_ar || "—",
          },
          {
            key: "sort_order",
            label: "Sort order",
            render: (row) => row.degree_group_sort_order ?? "—",
          },
          {
            key: "skip_major",
            label: "Skip major",
            render: (row) => (row.skip_major ? "Yes" : "No"),
          },
          {
            key: "degree_count",
            label: "Degrees",
            render: (row) => row.degree_count ?? 0,
          },
          {
            key: "actions",
            label: "Actions",
            render: (row) =>
              editingId !== row.degree_group_uuid ? (
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded hover:bg-red-500/10 text-destructive"
                  onClick={async () => {
                    if (confirm(`Delete degree group "${row.degree_group_name_en}"?`)) {
                      const result = await deleteDegreeGroup(row.degree_group_uuid);
                      if (typeof result === "object" && "message" in result && result.message) {
                        alert(result.message);
                      }
                      router.refresh();
                    }
                  }}
                >
                  Delete
                </button>
              ) : null,
          },
        ]}
      />
    </WorkspaceShell>
  );
}

function CreateDegreeGroupForm({ onSuccess }: { onSuccess: () => void }) {
  const [state, action, pending] = useActionState(
    async (_prev: { error?: string } | null, formData: FormData) => {
      const nameEn = formData.get("nameEn") as string;
      const nameAr = formData.get("nameAr") as string;
      const sortOrder = formData.get("sortOrder") as string;
      const skipMajor = formData.get("skipMajor") as string;
      try {
        await createDegreeGroup({
          degree_group_name_en: nameEn,
          degree_group_name_ar: nameAr || undefined,
          degree_group_sort_order: sortOrder ? Number(sortOrder) : undefined,
          skip_major: skipMajor ? Number(skipMajor) : undefined,
        });
        onSuccess();
        return { error: undefined };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : "Failed to create degree group" };
      }
    },
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={action}
      className="flex flex-wrap items-end gap-3"
      onSubmit={() => setTimeout(() => { formRef.current?.reset(); }, 100)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="nameEn">English name *</Label>
        <Input
          id="nameEn"
          name="nameEn"
          required
          maxLength={255}
          placeholder="e.g. Science, Arts, Engineering"
          className="w-56"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="nameAr">Arabic name</Label>
        <Input
          id="nameAr"
          name="nameAr"
          maxLength={255}
          placeholder="الاسم بالعربية"
          className="w-56"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="sortOrder">Sort order</Label>
        <Input
          id="sortOrder"
          name="sortOrder"
          type="number"
          placeholder="0"
          className="w-20"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="skipMajor">Skip major</Label>
        <select
          id="skipMajor"
          name="skipMajor"
          className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="0">No</option>
          <option value="1">Yes</option>
        </select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding..." : "Add"}
      </Button>
      {state?.error ? (
        <p className="text-xs w-full text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

function EditDegreeGroupForm({
  row,
  onDone,
  onCancel,
}: {
  row: DegreeGroupListItem;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState(
    async (_prev: { error?: string } | null, formData: FormData) => {
      const nameEn = formData.get("nameEn") as string;
      const nameAr = formData.get("nameAr") as string;
      const sortOrder = formData.get("sortOrder") as string;
      const skipMajor = formData.get("skipMajor") as string;
      try {
        await updateDegreeGroup({
          degreeGroupUuid: row.degree_group_uuid,
          degree_group_name_en: nameEn,
          degree_group_name_ar: nameAr || undefined,
          degree_group_sort_order: sortOrder ? Number(sortOrder) : undefined,
          skip_major: skipMajor ? Number(skipMajor) : undefined,
        });
        onDone();
        return { error: undefined };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : "Failed to update degree group" };
      }
    },
    null,
  );

  return (
    <form action={action} className="flex items-center gap-2 flex-wrap">
      <Input
        name="nameEn"
        defaultValue={row.degree_group_name_en}
        required
        maxLength={255}
        className="w-36 h-8"
      />
      <Input
        name="nameAr"
        defaultValue={row.degree_group_name_ar || ""}
        maxLength={255}
        placeholder="Name (AR)"
        className="w-36 h-8"
      />
      <Input
        name="sortOrder"
        defaultValue={row.degree_group_sort_order ?? ""}
        type="number"
        className="w-16 h-8"
      />
      <select
        name="skipMajor"
        defaultValue={row.skip_major ? "1" : "0"}
        className="flex h-8 w-20 rounded border border-input bg-transparent px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="0">No</option>
        <option value="1">Yes</option>
      </select>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "..." : "Save"}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      {state?.error ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}
