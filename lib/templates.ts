/**
 * Program template record shapes (alpha-exercise-library-002).
 *
 * A program template is a saved, reusable program shape: the same name +
 * description + ordered exercises as a program, stored in its own tenant-scoped
 * tables (program_template / template_exercise) so it never appears in the
 * program list or the assign flow. Templates are instantiated into a real
 * program for a member via `createProgramFromTemplateAction`.
 */

/** A template row as read by the staff dashboard (tenant-scoped via RLS). */
export type ProgramTemplateRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

/** A template row for the list view, with its exercise count. */
export type ProgramTemplateListRow = {
  id: string;
  name: string;
  description: string | null;
  exercise_count: number;
};
