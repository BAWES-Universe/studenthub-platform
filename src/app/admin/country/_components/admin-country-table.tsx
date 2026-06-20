"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import type { Route } from "next";

import type { SessionUser } from "@/modules/auth/types";
import type { CountryListItem } from "@/modules/admin/country/schemas";
import { createCountry, deleteCountry } from "@/modules/admin/country/actions";

type Props = {
  session: SessionUser;
  records: CountryListItem[];
};

export function AdminCountryTable({ session, records }: Props) {
  const router = useRouter();

  return (
    <WorkspaceShell
      session={session}
      eyebrow="Admin settings"
      title="Countries — manage country records."
      metrics={[
        { label: "Countries", value: records.length, note: "Active countries" },
      ]}
    >
      <section className="mb-6">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="text-sm font-semibold mb-3 text-foreground">Add a country</h3>
          <CreateCountryForm onSuccess={() => router.refresh()} />
        </div>
      </section>

      <DataTable
        title="Countries"
        description="List of all country records."
        rows={records.map((r) => ({ ...r, id: String(r.country_id) }))}
        rowHref={(row) => `/admin/country/${row.country_id}` as Route}
        columns={[
          {
            key: "emoji",
            label: "",
            render: (row) => (
              <span className="text-lg" role="img" aria-label={row.country_name_en ?? ""}>
                {row.emoji ?? "—"}
              </span>
            ),
          },
          {
            key: "country_name_en",
            label: "Name (English)",
            render: (row) => (
              <span className="text-sm font-medium text-foreground">
                {row.country_name_en ?? "—"}
              </span>
            ),
          },
          {
            key: "country_name_ar",
            label: "Name (Arabic)",
            render: (row) => (
              <span className="text-sm text-muted-foreground" dir="rtl">
                {row.country_name_ar ?? "—"}
              </span>
            ),
          },
          {
            key: "iso",
            label: "ISO",
            render: (row) => (
              <span className="text-sm text-muted-foreground">
                {row.iso ?? "—"}
              </span>
            ),
          },
          {
            key: "country_code",
            label: "Code",
            render: (row) => (
              <span className="text-sm text-muted-foreground">
                {row.country_code != null ? `+${row.country_code}` : "—"}
              </span>
            ),
          },
          {
            key: "currency_code",
            label: "Currency",
            render: (row) => (
              <span className="text-sm text-muted-foreground">
                {row.currency_code ?? "—"}
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
                  if (confirm(`Delete country "${row.country_name_en || row.country_name_ar || "Unnamed"}"?`)) {
                    try {
                      await deleteCountry(row.country_id);
                      router.refresh();
                    } catch {
                      alert("Failed to delete country");
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

function CreateCountryForm({ onSuccess }: { onSuccess: () => void }) {
  const [state, action, pending] = useActionState(
    async (_prev: { error?: string } | null, formData: FormData) => {
      const country_name_en = formData.get("country_name_en") as string;
      const country_name_ar = formData.get("country_name_ar") as string;
      const country_nationality_name_en = formData.get("country_nationality_name_en") as string;
      const country_nationality_name_ar = formData.get("country_nationality_name_ar") as string;
      const iso = formData.get("iso") as string;
      const emoji = formData.get("emoji") as string;
      const country_code = formData.get("country_code") as string;
      const currency_code = formData.get("currency_code") as string;

      try {
        await createCountry({
          country_name_en,
          country_name_ar: country_name_ar || "",
          country_nationality_name_en,
          country_nationality_name_ar: country_nationality_name_ar || "",
          iso: iso || "",
          emoji: emoji || "",
          country_code: country_code ? parseInt(country_code) : undefined,
          currency_code: currency_code || "",
        });
        onSuccess();
        return { error: undefined };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Failed to create country" };
      }
    },
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  const inputClass = "h-9 rounded-lg px-3 text-sm border";
  const inputStyle = { background: "var(--surface)", borderColor: "var(--border)", color: "var(--ink)" };

  return (
    <form
      ref={formRef}
      action={action}
      className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end"
      onSubmit={() => setTimeout(() => { formRef.current?.reset(); }, 100)}
    >
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Name (English)</label>
        <input name="country_name_en" maxLength={100} placeholder="e.g. Kuwait" className={inputClass} style={inputStyle} />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Name (Arabic)</label>
        <input name="country_name_ar" maxLength={100} placeholder="مثال: الكويت" className={inputClass} style={inputStyle} />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Nationality (English)</label>
        <input name="country_nationality_name_en" maxLength={100} placeholder="e.g. Kuwaiti" className={inputClass} style={inputStyle} />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Nationality (Arabic)</label>
        <input name="country_nationality_name_ar" maxLength={100} placeholder="مثال: كويتي" className={inputClass} style={inputStyle} />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">ISO</label>
        <input name="iso" maxLength={3} placeholder="KWT" className={inputClass} style={inputStyle} />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Emoji</label>
        <input name="emoji" maxLength={255} placeholder="🇰🇼" className={inputClass} style={inputStyle} />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Phone Code</label>
        <input name="country_code" type="number" placeholder="965" className={inputClass} style={inputStyle} />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Currency</label>
        <input name="currency_code" maxLength={3} placeholder="KWD" className={inputClass} style={inputStyle} />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="h-9 rounded-lg px-4 text-sm font-semibold bg-primary text-primary-foreground col-span-2 md:col-span-4 justify-self-start"
      >
        {pending ? "Adding..." : "Add Country"}
      </button>
      {state?.error ? (
        <p className="text-xs w-full text-destructive col-span-full">{state.error}</p>
      ) : null}
    </form>
  );
}
