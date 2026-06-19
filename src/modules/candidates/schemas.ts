import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared output schemas
// ---------------------------------------------------------------------------

/** Shared schema for { error: string } returns used by most form actions */
export const candidateErrorResultSchema = z.object({
  error: z.string(),
});

/** Shared schema for { success: boolean; fieldErrors?: Record<string, string[] | undefined> } */
export const profileStateSchema = z.object({
  success: z.boolean(),
  fieldErrors: z.record(z.array(z.string()).optional()).optional(),
});

/** Shared schema for { success: boolean; error?: string } */
export const languageStateSchema: z.ZodType<{ success: boolean; error?: string }> = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

/** Shared schema for { success: boolean; error?: string } — same shape as LanguageState */
export const educationStateSchema: z.ZodType<{ success: boolean; error?: string }> = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Lookup helper schemas
// ---------------------------------------------------------------------------

/** Schema for { id: number, label: string } options (country, university, bank) */
export const numericOptionSchema = z.object({
  id: z.number().int(),
  label: z.string(),
});

/** Schema for { id: string, label: string } options (degree, major) */
export const stringIdOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
});

// ---------------------------------------------------------------------------
// Derived types (explicit — Zod 3.25 inference produces different optional
// handling than the original inline types, so we define them manually)
// ---------------------------------------------------------------------------

export type CandidateErrorResult = { error: string };
export type ProfileState = { success: boolean; fieldErrors?: Record<string, string[] | undefined> };
export type LanguageState = { success: boolean; error?: string };
export type EducationState = { success: boolean; error?: string };
export type NumericOption = { id: number; label: string };
export type StringIdOption = { id: string; label: string };
