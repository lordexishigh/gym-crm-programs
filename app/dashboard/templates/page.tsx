import Link from "next/link";
import { requireStaff } from "@/lib/auth/session";
import { withTenantContext } from "@/lib/db";
import type { ProgramTemplateListRow } from "@/lib/templates";
import {
  createProgramFromTemplateAction,
  deleteTemplateAction,
} from "./actions";

export const dynamic = "force-dynamic";

/**
 * Program templates (alpha-exercise-library-002). The query carries no tenant
 * predicate — RLS (`program_template_staff_all`) scopes it to the staff
 * member's gym. "Use template" instantiates a template into a new program;
 * templates are created from a program's detail page ("Save as template").
 */
export default async function TemplatesPage() {
  const session = await requireStaff();

  const templates = await withTenantContext(session.identity, async (c) => {
    const { rows } = await c.query<ProgramTemplateListRow>(
      `select
         t.id,
         t.name,
         t.description,
         (select count(*) from template_exercise te where te.template_id = t.id)::int
           as exercise_count
       from program_template t
       order by t.name asc`,
    );
    return rows;
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Program templates</h1>
        <p className="text-sm text-slate-600">
          Reusable program shapes. Create one from a program’s page (“Save as
          template”), then start new programs from it here.
        </p>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No templates yet. Open a{" "}
          <Link
            href="/dashboard/programs"
            className="font-medium text-brand hover:underline"
          >
            program
          </Link>{" "}
          and choose “Save as template” to reuse it later.
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {templates.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-slate-900">
                  {t.name}
                </span>
                <span className="truncate text-sm text-slate-500">
                  {t.description ?? "No description"}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                  {t.exercise_count}{" "}
                  {t.exercise_count === 1 ? "exercise" : "exercises"}
                </span>
                <form action={createProgramFromTemplateAction}>
                  <input type="hidden" name="templateId" value={t.id} />
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-dark"
                  >
                    Use template
                  </button>
                </form>
                <form action={deleteTemplateAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <button
                    type="submit"
                    aria-label={`Delete template ${t.name}`}
                    className="rounded-md border border-slate-300 px-2 py-1 text-sm font-medium text-red-600 transition hover:bg-red-50"
                  >
                    Delete
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
