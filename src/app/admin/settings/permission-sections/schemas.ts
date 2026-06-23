import { z } from "zod";

export const createSectionSchema = z.object({
  sectionName: z.string().min(1, "Section name is required").max(255),
});

export const updateSectionSchema = z.object({
  permissionUuid: z.string().min(1, "Permission UUID is required"),
  sectionName: z.string().min(1, "Section name is required").max(255),
});

export type CreateSectionInput = z.infer<typeof createSectionSchema>;
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;
