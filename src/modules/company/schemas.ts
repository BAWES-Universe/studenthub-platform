import { z } from "zod";

// ---------------------------------------------------------------------------
// Output validation schemas
// ---------------------------------------------------------------------------

/** Schema for { error: string } returns used by all company form actions */
export const companyErrorResultSchema = z.object({
  error: z.string(),
});

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

export type CompanyErrorResult = z.output<typeof companyErrorResultSchema>;
