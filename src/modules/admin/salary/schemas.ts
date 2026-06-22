import { z } from "zod";

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

export const salaryListItemSchema = z.object({
  staff_salary_uuid: z.string(),
  staff_id: z.number().int().nullable(),
  staff_name: z.string(),
  salary: z.number().nullable(),
  salary_currency: z.string().nullable(),
  comment: z.string().nullable(),
  salary_date: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export const salaryDetailSchema = z.object({
  staff_salary_uuid: z.string(),
  staff_id: z.number().int().nullable(),
  staff_name: z.string(),
  staff_email: z.string().nullable(),
  salary: z.number().nullable(),
  salary_currency: z.string().nullable(),
  comment: z.string().nullable(),
  salary_date: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export const listSalaryResultSchema = z.object({
  records: z.array(salaryListItemSchema),
  total: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Types derived from output schemas
// ---------------------------------------------------------------------------

export type SalaryListItem = z.output<typeof salaryListItemSchema>;
export type SalaryDetail = z.output<typeof salaryDetailSchema>;
export type ListSalaryResult = z.output<typeof listSalaryResultSchema>;
