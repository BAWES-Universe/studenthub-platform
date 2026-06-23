// ---------------------------------------------------------------------------
// Barrel re-export — delegates to module-level implementation
// ---------------------------------------------------------------------------
// All business logic lives in src/modules/admin/university/actions.ts (which
// has "use server"). This barrel re-exports so page consumers keep their
// current import paths without duplicating the "use server" directive.
// -------------------------------------

export {
  listUniversities,
  createUniversity,
  updateUniversity,
  deleteUniversity,
} from "@/modules/admin/university/actions";

export type {
  UniversityListItem,
  ListUniversitiesResult,
  UniversityIdResult,
} from "@/modules/admin/university/schemas";
