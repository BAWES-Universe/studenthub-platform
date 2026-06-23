"use client";

import { useActionState } from "react";
import { addCompanyStore } from "@/modules/company/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
    <form action={action} className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h3 className="mb-4 text-lg font-semibold text-foreground">Add Store</h3>
      <div className="space-y-3">
        <Select name="companyId">
          <SelectTrigger disabled={pending}>
            <SelectValue placeholder="Select company" />
          </SelectTrigger>
          <SelectContent>
            {companies.map((c) => (
              <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input name="storeName" placeholder="Store name" required disabled={pending} />
        <Input name="storeLocation" placeholder="Location (address)" disabled={pending} />
        <Select name="mallUuid">
          <SelectTrigger disabled={pending}>
            <SelectValue placeholder="No mall" />
          </SelectTrigger>
          <SelectContent>
            {malls.map((m) => (
              <SelectItem key={m.uuid} value={m.uuid}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select name="brandUuid">
          <SelectTrigger disabled={pending}>
            <SelectValue placeholder="No brand" />
          </SelectTrigger>
          <SelectContent>
            {brands.map((b) => (
              <SelectItem key={b.uuid} value={b.uuid}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Adding..." : "Add Store"}
        </Button>
      </div>
      {state.error && (
        <p className="mt-2 text-sm font-bold text-rose-600">{state.error}</p>
      )}
    </form>
  );
}
