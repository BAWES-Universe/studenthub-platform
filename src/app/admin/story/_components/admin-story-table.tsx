"use client";

import { useActionState, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Add story</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateStoryForm onSuccess={() => router.refresh()} />
          </CardContent>
        </Card>
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
                <Button
                  type="button"
                  variant="ghost"
                  className="text-sm p-0 h-auto font-normal"
                  onClick={() => setEditingId(row.story_uuid)}
                >
                  {row.staff_name ?? "—"}
                </Button>
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
        <Select name="storyStatus" defaultValue="0">
            <SelectTrigger className="h-9 w-fit">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Draft</SelectItem>
              <SelectItem value="1">Active</SelectItem>
              <SelectItem value="2">Closed</SelectItem>
            </SelectContent>
          </Select>
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
      <Select name="storyStatus" defaultValue={String(row.story_status)}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Draft</SelectItem>
              <SelectItem value="1">Active</SelectItem>
              <SelectItem value="2">Closed</SelectItem>
            </SelectContent>
          </Select>
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