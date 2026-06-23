"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormSelect } from "./FormSelect";
import { createRequestAction } from "./create-actions";

interface RequestCreateFormProps {
  companies: { id: number; name: string }[];
  redirectTo: string;
}

const companyOptions = (companies: { id: number; name: string }[]): { value: string; label: string }[] =>
  companies.map((c) => ({ value: String(c.id), label: c.name }));

const priorityOptions = [
  { value: "0", label: "Normal" },
  { value: "1", label: "High" },
  { value: "2", label: "Urgent" },
];

export function RequestCreateForm({ companies, redirectTo }: RequestCreateFormProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create New Request</CardTitle>
        <CardDescription>Fill in the position details and skills required.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={createRequestAction} className="grid gap-5">
          <input name="redirect_to" type="hidden" value={redirectTo} />

          <div className="grid gap-2">
            <Label htmlFor="company_id">Company</Label>
            <FormSelect
              name="company_id"
              options={[{ value: "", label: "Select a company..." }, ...companyOptions(companies)]}
              placeholder="Select a company..."
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="position_title">Position Title</Label>
            <Input
              id="position_title"
              name="position_title"
              placeholder="e.g. Front-end Developer"
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="job_description">Job Description</Label>
            <Textarea
              id="job_description"
              name="job_description"
              rows={4}
              placeholder="Describe the role and responsibilities..."
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="compensation">Compensation</Label>
            <Input name="compensation" placeholder="e.g. 250 KWD / month" />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="number_of_employees">Number of Employees</Label>
            <Input
              id="number_of_employees"
              name="number_of_employees"
              type="number"
              min={1}
              defaultValue={1}
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="location">Location</Label>
            <Input name="location" placeholder="e.g. Kuwait City" />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="additional_info">Additional Info</Label>
            <Textarea name="additional_info" rows={2} placeholder="Any extra notes..." />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="skills">Skills (comma-separated)</Label>
            <Input name="skills" placeholder="e.g. React, TypeScript, Node.js" />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="priority">Priority</Label>
            <FormSelect name="priority" options={priorityOptions} placeholder="Normal" defaultValue="0" />
          </div>

          <Button type="submit" className="w-full sm:w-auto">
            Create Request
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
