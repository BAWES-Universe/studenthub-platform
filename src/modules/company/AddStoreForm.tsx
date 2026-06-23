"use client";

import { useActionState } from "react";
import { addCompanyStore } from "@/modules/company/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AddStoreForm({
  companies,
  malls,
  brands
}: {
  companies: { id: number; name: string }[];
  malls: { uuid: string; name: string }[];
  brands: { uuid: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(addCompanyStore, { error: "" });

  return (
    <form action={action} className="grid gap-3 p-4 border border-border rounded-lg bg-card">
      <h3 className="text-sm font-semibold m-0">Add Store</h3>
      <div className="grid gap-2.5">
        <select
          name="companyId"
          required
          disabled={pending}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">Select company</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <Input name="storeName" placeholder="Store name" required disabled={pending} />
        <Input name="storeLocation" placeholder="Location (address)" disabled={pending} />
        <select
          name="mallUuid"
          disabled={pending}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">No mall</option>
          {malls.map((m) => (
            <option key={m.uuid} value={m.uuid}>{m.name}</option>
          ))}
        </select>
        <select
          name="brandUuid"
          disabled={pending}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">No brand</option>
          {brands.map((b) => (
            <option key={b.uuid} value={b.uuid}>{b.name}</option>
          ))}
        </select>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding..." : "Add Store"}
        </Button>
      </div>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
