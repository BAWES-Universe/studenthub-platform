"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateExpense, deleteExpense } from "../actions";

const EXPENSE_TYPES = [
  "Administrative",
  "Travel",
  "Supplies",
  "Utilities",
  "Maintenance",
  "Marketing",
  "Salary",
  "Other"
] as const;

interface ExpenseDetail {
  expense_uuid: string;
  title: string;
  type: string;
  detail: string | null;
  amount: number | null;
  transaction_datetime: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  admin_expense_created_byToadmin: { admin_name: string } | null;
  admin_expense_updated_byToadmin: { admin_name: string } | null;
}

export function ExpenseDetailForm({
  expense,
}: {
  expense: ExpenseDetail;
}) {
  const [title, setTitle] = useState(expense.title);
  const [type, setType] = useState(expense.type);
  const [detail, setDetail] = useState(expense.detail ?? "");
  const [amount, setAmount] = useState(
    expense.amount ? String(expense.amount) : ""
  );
  const [transactionDatetime, setTransactionDatetime] = useState(
    expense.transaction_datetime
      ? new Date(expense.transaction_datetime).toISOString().slice(0, 16)
      : ""
  );

  const updateAction = async (_prevState: unknown, formData: FormData) => {
    formData.set("title", title);
    formData.set("type", type);
    formData.set("detail", detail);
    formData.set("amount", amount);
    formData.set("transaction_datetime", transactionDatetime);

    await updateExpense(expense.expense_uuid, {
      title,
      type,
      detail: detail || undefined,
      amount: amount ? Number(amount) : undefined,
      transaction_datetime: transactionDatetime || undefined,
    });
    return { success: true };
  };

  const [state, formAction, pending] = useActionState(updateAction, null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Edit Expense</CardTitle>
          <CardDescription>
            Update the expense title, type, amount, and transaction details.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  name="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="type">Type</Label>
                <Select
                  value={type}
                  onValueChange={(val) => setType(val)}
                >
                  <SelectTrigger id="type" className="w-full">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPENSE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="amount">Amount</Label>
                <Input
                  id="amount"
                  name="amount"
                  type="number"
                  step="0.001"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="transaction_datetime">Transaction Date & Time</Label>
                <Input
                  id="transaction_datetime"
                  name="transaction_datetime"
                  type="datetime-local"
                  value={transactionDatetime}
                  onChange={(e) => setTransactionDatetime(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="detail">Detail</Label>
              <textarea
                id="detail"
                name="detail"
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                rows={3}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Save Changes"}
              </Button>
              {state?.success && (
                <span className="text-sm text-[var(--sh-success)] font-medium">
                  Saved successfully
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Separator />

      <Card className="border-[var(--sh-error)]/20">
        <CardHeader>
          <CardTitle className="text-[var(--sh-error)]">Danger Zone</CardTitle>
          <CardDescription>
            Deleting this expense record will permanently remove it. This
            action cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={async () => {
              await deleteExpense(expense.expense_uuid);
            }}
          >
            <Button type="submit" variant="destructive">
              Delete Expense
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
