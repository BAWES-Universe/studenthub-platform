"use client";

import { useActionState } from "react";
import { addCompanyContact } from "@/modules/company/actions";
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

export function AddContactForm({ companies }: { companies: { id: number; name: string }[] }) {
  const [state, action, pending] = useActionState(addCompanyContact, { error: "" });

  return (
    <form action={action} className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h3 className="mb-4 text-lg font-semibold text-foreground">Add Contact</h3>
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
        <Input name="name" placeholder="Contact name" required disabled={pending} />
        <Input name="email" type="email" placeholder="Email" disabled={pending} />
        <Input name="position" placeholder="Position (e.g. HR, Manager)" disabled={pending} />
        <Input name="phone" type="tel" placeholder="Phone" disabled={pending} />
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            name="allowAccess"
            type="checkbox"
            value="1"
            defaultChecked
            disabled={pending}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary/30"
          />
          Allow access
        </label>
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Adding..." : "Add Contact"}
        </Button>
      </div>
      {state.error && (
        <p className="mt-2 text-sm font-bold text-rose-600">{state.error}</p>
      )}
    </form>
  );
}
