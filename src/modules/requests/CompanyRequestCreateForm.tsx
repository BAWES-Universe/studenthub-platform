"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createCompanyRequest, type CompanyRequestFormState } from "./company-create-actions";

interface CompanyRequestCreateFormProps {
  companies: { id: number; name: string }[];
}

const initialState: CompanyRequestFormState = { success: false };

export function CompanyRequestCreateForm({ companies }: CompanyRequestCreateFormProps) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState(createCompanyRequest, initialState);

  useEffect(() => {
    if (state.success && state.requestUuid) {
      router.push(`/company/requests/${state.requestUuid}`);
    }
  }, [state.success, state.requestUuid, router]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Hiring Request</CardTitle>
        <CardDescription>Fill in the required details for a new position.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={dispatch} className="space-y-5">
          {/* Company */}
          <div className="space-y-2">
            <Label htmlFor="company_id">Company</Label>
            <Select name="company_id" required>
              <SelectTrigger id="company_id">
                <SelectValue placeholder="Select a company..." />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {state.errors?.company_id && (
              <p className="text-destructive text-sm">{state.errors.company_id}</p>
            )}
          </div>

          {/* Job Title */}
          <div className="space-y-2">
            <Label htmlFor="position_title">Job Title</Label>
            <Input
              id="position_title"
              name="position_title"
              placeholder="e.g. Sales Associate"
              required
            />
            {state.errors?.position_title && (
              <p className="text-destructive text-sm">{state.errors.position_title}</p>
            )}
          </div>

          {/* Compensation */}
          <div className="space-y-2">
            <Label htmlFor="compensation">Compensation Type</Label>
            <Input
              id="compensation"
              name="compensation"
              placeholder="e.g. 300 KWD / month"
              required
            />
            {state.errors?.compensation && (
              <p className="text-destructive text-sm">{state.errors.compensation}</p>
            )}
          </div>

          {/* Store */}
          <div className="space-y-2">
            <Label htmlFor="store">Store</Label>
            <Input
              id="store"
              name="store"
              placeholder="e.g. Avenues Mall Branch"
              required
            />
            {state.errors?.store && (
              <p className="text-destructive text-sm">{state.errors.store}</p>
            )}
          </div>

          {/* Brand */}
          <div className="space-y-2">
            <Label htmlFor="brand">Brand</Label>
            <Input
              id="brand"
              name="brand"
              placeholder="e.g. Nike"
              required
            />
            {state.errors?.brand && (
              <p className="text-destructive text-sm">{state.errors.brand}</p>
            )}
          </div>

          {/* Vacancy Count */}
          <div className="space-y-2">
            <Label htmlFor="number_of_employees">Vacancy Count</Label>
            <Input
              id="number_of_employees"
              name="number_of_employees"
              type="number"
              min={1}
              defaultValue={1}
              required
            />
            {state.errors?.number_of_employees && (
              <p className="text-destructive text-sm">{state.errors.number_of_employees}</p>
            )}
          </div>

          {state.error && (
            <p className="text-destructive text-sm font-medium">{state.error}</p>
          )}

          <Button type="submit" disabled={pending} className="w-full sm:w-auto">
            {pending ? "Creating..." : "Create Request"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
