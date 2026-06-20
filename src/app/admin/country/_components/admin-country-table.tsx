"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { DataTable } from "@/modules/workspace/DataTable";
import { WorkspaceShell } from "@/modules/workspace/WorkspaceShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
        <Card className="p-5">
          <h3 className="text-sm font-semibold mb-3 text-foreground">Add a country</h3>
          <CreateCountryForm onSuccess={() => router.refresh()} />
        </Card>
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
              <DeleteCountryButton
                countryId={row.country_id}
                countryName={row.country_name_en || row.country_name_ar || "Unnamed"}
                onDelete={async () => {
                  await deleteCountry(row.country_id);
                  router.refresh();
                }}
              />
            ),
          },
        ]}
      />
    </WorkspaceShell>
  );
}

function DeleteCountryButton({
  countryId,
  countryName,
  onDelete,
}: {
  countryId: number;
  countryName: string;
  onDelete: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete country</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{countryName}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="text-sm text-destructive font-medium">{error}</p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={loading}
            onClick={async (e) => {
              e.preventDefault();
              setLoading(true);
              setError(null);
              try {
                await onDelete();
                setOpen(false);
              } catch {
                setError("Failed to delete country");
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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

  return (
    <form
      ref={formRef}
      action={action}
      className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end"
      onSubmit={() => setTimeout(() => { formRef.current?.reset(); }, 100)}
    >
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Name (English)</label>
        <Input name="country_name_en" maxLength={100} placeholder="e.g. Kuwait" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Name (Arabic)</label>
        <Input name="country_name_ar" maxLength={100} placeholder="مثال: الكويت" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Nationality (English)</label>
        <Input name="country_nationality_name_en" maxLength={100} placeholder="e.g. Kuwaiti" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Nationality (Arabic)</label>
        <Input name="country_nationality_name_ar" maxLength={100} placeholder="مثال: كويتي" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">ISO</label>
        <Input name="iso" maxLength={3} placeholder="KWT" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Emoji</label>
        <Input name="emoji" maxLength={255} placeholder="🇰🇼" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Phone Code</label>
        <Input name="country_code" type="number" placeholder="965" />
      </div>
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Currency</label>
        <Input name="currency_code" maxLength={3} placeholder="KWD" />
      </div>
      <Button
        type="submit"
        disabled={pending}
        className="col-span-2 md:col-span-4 justify-self-start"
      >
        {pending ? "Adding..." : "Add Country"}
      </Button>
      {state?.error ? (
        <p className="text-xs w-full text-destructive col-span-full">{state.error}</p>
      ) : null}
    </form>
  );
}
