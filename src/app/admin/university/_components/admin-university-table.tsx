"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import type { Route } from "next";

import type { SessionUser } from "@/modules/auth/types";
import type { UniversityListItem } from "../schemas";
import { createUniversity, deleteUniversity } from "../actions";

type Props = {
  session: SessionUser;
  records: UniversityListItem[];
};

export function AdminUniversityTable({ session, records }: Props) {
  const router = useRouter();

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin settings"
      title="Universities — manage institution records."
      metrics={[
        { label: "Universities", value: records.length, note: "Active institutions" },
      ]}
    >
      <section className="mb-6">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="text-sm font-semibold mb-3 text-foreground">Add a university</h3>
          <CreateUniversityForm onSuccess={() => router.refresh()} />
        </div>
      </section>

      <DataTable
        title="Universities"
        description="List of all active university records."
        rows={records.map((r) => ({ ...r, id: String(r.university_id) }))}
        rowHref={(row) => `/admin/university/${row.university_id}` as Route}
        columns={[
          {
            key: "university_name_en",
            label: "Name (English)",
            render: (row) => (
              <span className="text-sm font-medium text-foreground">
                {row.university_name_en ?? "—"}
              </span>
            ),
          },
          {
            key: "university_name_ar",
            label: "Name (Arabic)",
            render: (row) => (
              <span className="text-sm text-muted-foreground" dir="rtl">
                {row.university_name_ar ?? "—"}
              </span>
            ),
          },
          {
            key: "candidate_count",
            label: "Candidates",
            render: (row) => (
              <span className="text-sm text-muted-foreground">
                {row.candidate_count ?? "—"}
              </span>
            ),
          },
          {
            key: "actions",
            label: "",
            render: (row) => (
              <button
                type="button"
                className="text-xs px-2 py-1 rounded hover:bg-red-500/10 text-destructive"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (confirm(`Delete university "${row.university_name_en || row.university_name_ar || "Unnamed"}"?`)) {
                    try {
                      await deleteUniversity(row.university_id);
                      router.refresh();
                    } catch {
                      alert("Failed to delete university");
                    }
                  }
                }}
              >
                Delete
              </button>
            ),
          },
        ]}
      />
    </WorkspaceShell>
  );
}

function CreateUniversityForm({ onSuccess }: { onSuccess: () => void }) {
  const [state, action, pending] = useActionState(
    async (_prev: { error?: string } | null, formData: FormData) => {
      const university_name_en = formData.get("university_name_en") as string;
      const university_name_ar = formData.get("university_name_ar") as string;

      try {
        await createUniversity({
          university_name_en: university_name_en || "",
          university_name_ar: university_name_ar || undefined,
        });
        onSuccess();
        return { error: undefined };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Failed to create university" };
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
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Name (English)</label>
        <input
          name="university_name_en"
          maxLength={100}
          placeholder="e.g. Kuwait University"
          className="h-9 rounded-lg px-3 text-sm border"
          style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--ink)" }}
        />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Name (Arabic)</label>
        <input
          name="university_name_ar"
          maxLength={100}
          placeholder="مثال: جامعة الكويت"
          className="h-9 rounded-lg px-3 text-sm border"
          style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--ink)" }}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="h-9 rounded-lg px-4 text-sm font-semibold bg-primary text-primary-foreground"
      >
        {pending ? "Adding..." : "Add University"}
      </button>
      {state?.error ? (
        <p className="text-xs w-full text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}
