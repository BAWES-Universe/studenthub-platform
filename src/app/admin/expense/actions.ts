"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireRoleCapability } from "@/modules/auth/session";

export async function getExpenseDetail(expenseUuid: string) {
  await requireRoleCapability("admin", "admin.system");

  const expense = await prisma.expense.findUnique({
    where: { expense_uuid: expenseUuid },
    select: {
      expense_uuid: true,
      title: true,
      type: true,
      detail: true,
      amount: true,
      transaction_datetime: true,
      created_at: true,
      updated_at: true,
      admin_expense_created_byToadmin: { select: { admin_name: true } },
      admin_expense_updated_byToadmin: { select: { admin_name: true } }
    }
  });

  return expense;
}

export async function updateExpense(
  expenseUuid: string,
  data: {
    title: string;
    type: string;
    detail?: string;
    amount?: number;
    transaction_datetime?: string;
  }
) {
  await requireRoleCapability("admin", "admin.system");

  await prisma.expense.update({
    where: { expense_uuid: expenseUuid },
    data: {
      title: data.title,
      type: data.type,
      detail: data.detail ?? null,
      amount: data.amount ?? null,
      transaction_datetime: data.transaction_datetime
        ? new Date(data.transaction_datetime)
        : null,
      updated_at: new Date()
    }
  });

  revalidatePath("/admin/expense");
}

export async function createExpense(data: {
  title: string;
  type: string;
  detail?: string;
  amount?: number;
  transaction_datetime?: string;
}) {
  await requireRoleCapability("admin", "admin.system");

  const uuid = crypto.randomUUID();

  await prisma.expense.create({
    data: {
      expense_uuid: uuid,
      title: data.title,
      type: data.type,
      detail: data.detail ?? null,
      amount: data.amount ?? null,
      transaction_datetime: data.transaction_datetime
        ? new Date(data.transaction_datetime)
        : null,
      created_at: new Date(),
      updated_at: new Date()
    }
  });

  revalidatePath("/admin/expense");
  return { uuid };
}

export async function deleteExpense(expenseUuid: string) {
  await requireRoleCapability("admin", "admin.system");

  await prisma.expense.delete({
    where: { expense_uuid: expenseUuid }
  });

  revalidatePath("/admin/expense");
}
