"use client";

import { useActionState } from "react";
import { addCompanyContact } from "@/modules/company/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AddContactForm({ companies }: { companies: { id: number; name: string }[] }) {
  const [state, action, pending] = useActionState(addCompanyContact, { error: "" });

  return (
    <form action={action} className="grid gap-3 p-4 border border-border rounded-lg bg-card">
      <h3 className="text-sm font-semibold m-0">Add Contact</h3>
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
        <Input name="name" placeholder="Contact name" required disabled={pending} />
        <Input name="email" type="email" placeholder="Email" disabled={pending} />
        <Input name="position" placeholder="Position (e.g. HR, Manager)" disabled={pending} />
        <Input name="phone" type="tel" placeholder="Phone" disabled={pending} />
        <label className="flex items-center gap-2 text-sm">
          <input name="allowAccess" type="checkbox" value="1" defaultChecked disabled={pending} className="h-4 w-4 rounded border-border" />
          Allow access
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding..." : "Add Contact"}
        </Button>
      </div>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
