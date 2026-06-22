"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireRoleCapability } from "@/modules/auth/session";
import {
  salaryListItemSchema,
  salaryDetailSchema,
  listSalaryResultSchema,
} from "./schemas";
import type {
  SalaryListItem,
  SalaryDetail,
  ListSalaryResult,
} from "./schemas";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function logOutputError(source: string, error: unknown): Promise<void> {
  console.error(`[modules/admin/salary] ${source} output failed:`, error);
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listSalarySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

// ---------------------------------------------------------------------------
// listSalaries
// ---------------------------------------------------------------------------

/**
 * List salary records with staff names.
 */
export async function listSalaries(
  params: FormData | z.input<typeof listSalarySchema> = {},
): Promise<ListSalaryResult> {
  await requireRoleCapability("admin", "admin.system");

  const raw =
    params instanceof FormData
      ? { limit: params.get("limit") }
      : params;

  const parsed = listSalarySchema.safeParse(raw);
  if (!parsed.success) {
    return { records: [], total: 0 };
  }

  const { limit } = parsed.data;

  const [records, total] = await Promise.all([
    prisma.staff_salary.findMany({
      orderBy: { salary_date: "desc" },
      take: limit,
      select: {
        staff_salary_uuid: true,
        staff_id: true,
        salary: true,
        salary_currency: true,
        comment: true,
        salary_date: true,
        created_at: true,
        updated_at: true,
        staff: { select: { staff_name: true } },
      },
    }),
    prisma.staff_salary.count(),
  ]);

  const result: ListSalaryResult = {
    records: records.map((r): SalaryListItem => ({
      staff_salary_uuid: r.staff_salary_uuid,
      staff_id: r.staff_id ?? null,
      staff_name: r.staff?.staff_name ?? "-",
      salary: r.salary ? Number(r.salary) : null,
      salary_currency: r.salary_currency ?? null,
      comment: r.comment ?? null,
      salary_date: r.salary_date
        ? r.salary_date.toISOString().split("T")[0]
        : null,
      created_at: r.created_at?.toISOString() ?? null,
      updated_at: r.updated_at?.toISOString() ?? null,
    })),
    total,
  };

  // Validate output shape
  const outputParsed = listSalaryResultSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("listSalaries", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// getSalaryDetail
// ---------------------------------------------------------------------------

/**
 * Get a single salary record with full staff details.
 */
export async function getSalaryDetail(
  salaryUuid: string,
): Promise<SalaryDetail | null> {
  await requireRoleCapability("admin", "admin.system");

  const record = await prisma.staff_salary.findUnique({
    where: { staff_salary_uuid: salaryUuid },
    select: {
      staff_salary_uuid: true,
      staff_id: true,
      salary: true,
      salary_currency: true,
      comment: true,
      salary_date: true,
      created_at: true,
      updated_at: true,
      staff: { select: { staff_name: true, staff_email: true } },
    },
  });

  if (!record) return null;

  const result: SalaryDetail = {
    staff_salary_uuid: record.staff_salary_uuid,
    staff_id: record.staff_id ?? null,
    staff_name: record.staff?.staff_name ?? "-",
    staff_email: record.staff?.staff_email ?? null,
    salary: record.salary ? Number(record.salary) : null,
    salary_currency: record.salary_currency ?? null,
    comment: record.comment ?? null,
    salary_date: record.salary_date
      ? record.salary_date.toISOString().split("T")[0]
      : null,
    created_at: record.created_at?.toISOString() ?? null,
    updated_at: record.updated_at?.toISOString() ?? null,
  };

  // Validate output shape
  const outputParsed = salaryDetailSchema.safeParse(result);
  if (!outputParsed.success) {
    logOutputError("getSalaryDetail", outputParsed.error.issues);
  }

  return result;
}

// ---------------------------------------------------------------------------
// createSalary
// ---------------------------------------------------------------------------

const createSalarySchema = z.object({
  staff_id: z.coerce.number().int().positive("Staff ID is required"),
  salary: z.coerce
    .number()
    .min(0, "Salary must be non-negative")
    .optional()
    .default(0),
  salary_currency: z
    .string()
    .max(3, "Currency must be at most 3 characters")
    .optional()
    .default("KWD"),
  comment: z
    .string()
    .max(255, "Comment must be at most 255 characters")
    .optional()
    .default(""),
  salary_date: z.string().optional(),
});

/**
 * Create a new salary record.
 */
export async function createSalary(
  data: z.input<typeof createSalarySchema>,
): Promise<{ uuid: string }> {
  await requireRoleCapability("admin", "admin.system");

  const parsed = createSalarySchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid salary data");
  }

  const { staff_id, salary, salary_currency, comment, salary_date } =
    parsed.data;

  const uuid = crypto.randomUUID();

  await prisma.staff_salary.create({
    data: {
      staff_salary_uuid: uuid,
      staff_id,
      salary,
      salary_currency: salary_currency || null,
      comment: comment || null,
      salary_date: salary_date ? new Date(salary_date) : new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  revalidatePath("/admin/salary");
  return { uuid };
}

// ---------------------------------------------------------------------------
// updateSalary
// ---------------------------------------------------------------------------

const updateSalarySchema = z.object({
  uuid: z.string(),
  staff_id: z.coerce.number().int().positive().optional(),
  salary: z.coerce.number().min(0).optional(),
  salary_currency: z.string().max(3).optional(),
  comment: z.string().max(255).optional(),
  salary_date: z.string().optional(),
});

/**
 * Update an existing salary record.
 */
export async function updateSalary(
  data: z.input<typeof updateSalarySchema>,
): Promise<void> {
  await requireRoleCapability("admin", "admin.system");

  const parsed = updateSalarySchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid salary data");
  }

  const { uuid, ...updateFields } = parsed.data;

  // Verify the record exists
  const existing = await prisma.staff_salary.findUnique({
    where: { staff_salary_uuid: uuid },
  });
  if (!existing) {
    throw new Error(`Salary record not found: ${uuid}`);
  }

  const updateData: Record<string, unknown> = {};
  if (updateFields.staff_id !== undefined) updateData.staff_id = updateFields.staff_id;
  if (updateFields.salary !== undefined) updateData.salary = updateFields.salary;
  if (updateFields.salary_currency !== undefined)
    updateData.salary_currency = updateFields.salary_currency || null;
  if (updateFields.comment !== undefined)
    updateData.comment = updateFields.comment || null;
  if (updateFields.salary_date !== undefined)
    updateData.salary_date = new Date(updateFields.salary_date);
  updateData.updated_at = new Date();

  await prisma.staff_salary.update({
    where: { staff_salary_uuid: uuid },
    data: updateData as any,
  });

  revalidatePath("/admin/salary");
}

// ---------------------------------------------------------------------------
// deleteSalary
// ---------------------------------------------------------------------------

const deleteSalarySchema = z.object({
  uuid: z.string(),
});

/**
 * Delete a salary record.
 */
export async function deleteSalary(uuid: string): Promise<void> {
  await requireRoleCapability("admin", "admin.system");

  const parsed = deleteSalarySchema.safeParse({ uuid });
  if (!parsed.success) {
    throw new Error("Invalid salary UUID");
  }

  // Verify the record exists
  const existing = await prisma.staff_salary.findUnique({
    where: { staff_salary_uuid: uuid },
  });
  if (!existing) {
    throw new Error(`Salary record not found: ${uuid}`);
  }

  await prisma.staff_salary.delete({
    where: { staff_salary_uuid: uuid },
  });

  revalidatePath("/admin/salary");
}
