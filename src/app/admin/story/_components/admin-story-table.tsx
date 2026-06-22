"use client";

import { useActionState, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { SessionUser } from "@/modules/auth/types";
import type { StoryItem } from "../schemas";
import { createStory, updateStory, deleteStory } from "../actions";

type Props = {
  session: SessionUser;
  stories: StoryItem[];
};

export function AdminStoryTable({ session, stories }: Props) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin settings"
      title="Manage stories — track staffing requests and placement progress."
      metrics={[
        { label: "Total stories", value: stories.length, note: "Stories in the system" },
      ]}
    >
      <section className="mb-6">
        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="text-sm font-semibold mb-3 text-card-foreground">Add story</h3>
          <CreateStoryForm onSuccess={() => router.refresh()} />
        </div>
      </section>

      <DataTable
        title="Stories"
        description="All staffing stories. Click a row field to edit or delete."
        rows={stories.map((s) => ({ ...s, id: s.story_uuid }))}
        rowHref={undefined}
        columns={[
          {
            key: "position",
            label: "Position",
            render: (row) => (
              <span className="text-sm text-card-foreground">
                {row.request_position_title ?? "—"}
              </span>
            ),
          },
          {
            key: "staff",
            label: "Staff",
            render: (row) =>
              editingId === row.story_uuid ? (
                <EditStoryForm
                  row={row}
                  onDone={() => { setEditingId(null); router.refresh(); }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <button
                  type="button"
                  className="text-sm text-primary hover:underline"
                  onClick={() => setEditingId(row.story_uuid)}
                >
                  {row.staff_name ?? "—"}
                </button>
              ),
          },
          {
            key: "employees",
            label: "Employees",
            render: (row) =>
              editingId === row.story_uuid ? null : (
                <span className="text-sm text-card-foreground">
                  {row.number_of_employees ?? "—"}
                </span>
              ),
          },
          {
            key: "status",
            label: "Status",
            render: (row) =>
              editingId === row.story_uuid ? null : (
                <span className="text-sm text-muted-foreground">
                  {row.story_status === 1 ? "Active" : row.story_status === 2 ? "Closed" : "Draft"}
                </span>
              ),
          },
          {
            key: "updated",
            label: "Updated",
            render: (row) =>
              editingId === row.story_uuid ? null : (
                <span className="text-sm text-muted-foreground">
                  {row.story_last_updated_at
                    ? new Date(row.story_last_updated_at).toLocaleDateString()
                    : "—"}
                </span>
              ),
          },
          {
            key: "actions",
            label: "",
            render: (row) =>
              editingId !== row.story_uuid ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={async () => {
                    if (confirm(`Delete story for "${row.request_position_title ?? "unknown position"}"?`)) {
                      const result = await deleteStory(row.story_uuid);
                      if (result.operation === "error") {
                        alert(result.message);
                      }
                      router.refresh();
                    }
                  }}
                >
                  Delete
                </Button>
              ) : null,
          },
        ]}
      />
    </WorkspaceShell>
  );
}

function CreateStoryForm({ onSuccess }: { onSuccess: () => void }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    async (_prev: { error?: string } | null, formData: FormData) => {
      const result = await createStory(null, formData);
      if (result.operation === "success") {
        onSuccess();
        return { error: undefined };
      }
      return { error: result.message };
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
      <div className="grid gap-1">
        <Label className="text-xs font-medium">Request UUID *</Label>
        <Input name="requestUuid" required placeholder="e.g. req-abc-123" className="w-56" />
      </div>
      <div className="grid gap-1">
        <Label className="text-xs font-medium">Staff ID</Label>
        <Input name="staffId" type="number" placeholder="Optional" className="w-24" />
      </div>
      <div className="grid gap-1">
        <Label className="text-xs font-medium">Employees</Label>
        <Input name="numberOfEmployees" type="number" placeholder="#" className="w-20" />
      </div>
      <div className="grid gap-1">
        <Label className="text-xs font-medium">Status</Label>
        <select name="storyStatus"
          className="flex h-9 w-fit items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-70 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[placeholder]:text-muted-foreground *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40">
          <option value="0">Draft</option>
          <option value="1">Active</option>
          <option value="2">Closed</option>
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

function EditStoryForm({
  row, onDone, onCancel,
}: {
  row: StoryItem;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState(
    async (_prev: { error?: string } | null, formData: FormData) => {
      formData.set("storyUuid", row.story_uuid);
      const result = await updateStory(null, formData);
      if (result.operation === "success") {
        onDone();
        return { error: undefined };
      }
      return { error: result.message };
    },
    null,
  );

  return (
    <form action={action} className="flex items-center gap-2 flex-wrap">
      <Input name="requestUuid" defaultValue={row.request_uuid} required className="w-40 h-8 text-sm" />
      <Input name="staffId" type="number" defaultValue={row.staff_id ?? ""} placeholder="Staff ID" className="w-24 h-8 text-sm" />
      <Input name="numberOfEmployees" type="number" defaultValue={row.number_of_employees ?? ""} placeholder="#" className="w-20 h-8 text-sm" />
      <select name="storyStatus" defaultValue={row.story_status}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30">
        <option value="0">Draft</option>
        <option value="1">Active</option>
        <option value="2">Closed</option>
      </select>
      <input name="isOld" type="checkbox" defaultChecked={row.is_old ?? false} className="hidden" />
      <Input name="storyTimeSpent" type="number" defaultValue={row.story_time_spent ?? ""} placeholder="Time" className="w-16 h-8 text-sm" />
      <Button type="submit" disabled={pending} size="sm">
        {pending ? "..." : "Save"}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      {state?.error ? (
        <p className="text-xs w-full text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}