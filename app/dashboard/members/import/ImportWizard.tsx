"use client";

import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import {
  COLUMN_LABELS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  SAMPLE_CSV,
  parseMemberCsv,
  type ImportPreview,
} from "@/lib/member-import";
import {
  importMembersAction,
  type ImportActionState,
  type ImportSummary,
} from "./actions";

/**
 * Three-step bulk import: choose a file → review what will happen → confirm.
 *
 * The preview is computed in the browser from the picked file using the same
 * pure parser the Server Action runs, so staff see the exact outcome with no
 * round-trip and no half-uploaded state on the server. Nothing is written until
 * the confirm button is pressed, and the action re-parses authoritatively.
 */

/** How many accepted rows to show in the preview table before collapsing. */
const PREVIEW_ROWS = 8;
/** How many rejected rows to list before collapsing. */
const PREVIEW_ISSUES = 15;

export function ImportWizard() {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [csv, setCsv] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  // `useActionState` has no reset, so "import another file" would otherwise be
  // stuck on the result screen forever. Remember WHICH summary was dismissed —
  // a later import returns a fresh object, so its result still displays.
  const [dismissed, setDismissed] = useState<ImportSummary | null>(null);

  const [state, formAction, pending] = useActionState<ImportActionState, FormData>(
    importMembersAction,
    {},
  );

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setReadError(null);
    setFileName(file.name);

    // Check the size before reading — no point pulling a 50 MB file into memory
    // just to reject it.
    if (file.size > IMPORT_MAX_BYTES) {
      setPreview(null);
      setCsv("");
      setReadError(
        `That file is ${Math.round(file.size / 1000)} KB; the limit is ${IMPORT_MAX_BYTES / 1000} KB. Split it into smaller files.`,
      );
      return;
    }

    let text: string;
    try {
      text = await file.text();
    } catch {
      setPreview(null);
      setCsv("");
      setReadError("That file could not be read. Try exporting it again.");
      return;
    }

    setCsv(text);
    setPreview(parseMemberCsv(text));
  }

  function reset() {
    setPreview(null);
    setCsv("");
    setFileName("");
    setReadError(null);
    setDismissed(state.summary ?? null);
    if (fileInput.current) fileInput.current.value = "";
  }

  // ---- Step 3: done -------------------------------------------------------
  if (state.summary && state.summary !== dismissed) {
    const s = state.summary;
    return (
      <div className="flex flex-col gap-5 rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-slate-900">
            {s.imported > 0 ? "Import complete" : "Nothing new to import"}
          </h2>
          <p className="text-sm text-slate-600">
            {s.imported > 0
              ? `${s.imported} member${s.imported === 1 ? "" : "s"} added to your roster from ${fileName || "the file"}.`
              : `Every row in ${fileName || "the file"} was already on your roster or could not be imported.`}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Rows in file" value={s.total} />
          <Stat label="Imported" value={s.imported} tone="success" />
          <Stat label="Already existed" value={s.skippedExisting} tone="muted" />
          <Stat label="Skipped" value={s.skippedInvalid} tone={s.skippedInvalid > 0 ? "warning" : "muted"} />
        </dl>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/dashboard/members"
            className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark"
          >
            View roster
          </Link>
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            Import another file
          </button>
        </div>
      </div>
    );
  }

  // ---- Step 2: preview ----------------------------------------------------
  if (preview?.ok) {
    const accepted = preview.rows.length;
    const rejected = preview.issues.length;

    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-5 rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-slate-900">Review this import</h2>
              <p className="text-sm text-slate-600">
                Nothing has been saved yet. Check the rows below, then confirm.
              </p>
            </div>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Choose a different file
            </button>
          </div>

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="File" value={fileName || "—"} />
            <Stat label="Ready to import" value={accepted} tone="success" />
            <Stat
              label="Will be skipped"
              value={rejected}
              tone={rejected > 0 ? "warning" : "muted"}
            />
          </dl>

          <div className="flex flex-col gap-2 text-sm">
            <p className="text-slate-600">
              <span className="font-medium text-slate-700">Columns recognised: </span>
              {preview.mapped
                .map((m) => `${m.header} → ${COLUMN_LABELS[m.column]}`)
                .join(", ")}
            </p>
            {preview.ignored.length > 0 ? (
              <p className="text-slate-500">
                <span className="font-medium">Ignored columns: </span>
                {preview.ignored.join(", ")} — these are not stored.
              </p>
            ) : null}
          </div>
        </div>

        {accepted > 0 ? (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-700">
              {accepted === 1 ? "The member" : `The first ${Math.min(PREVIEW_ROWS, accepted)} of ${accepted} members`} to be created
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th scope="col" className="px-4 py-2 font-medium">Line</th>
                    <th scope="col" className="px-4 py-2 font-medium">Name</th>
                    <th scope="col" className="px-4 py-2 font-medium">Email</th>
                    <th scope="col" className="px-4 py-2 font-medium">Phone</th>
                    <th scope="col" className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {preview.rows.slice(0, PREVIEW_ROWS).map((r) => (
                    <tr key={r.line}>
                      <td className="px-4 py-2 text-slate-500">{r.line}</td>
                      <td className="px-4 py-2 font-medium text-slate-900">
                        {r.input.fullName}
                      </td>
                      <td className="px-4 py-2 text-slate-600">
                        {r.input.email ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-slate-600">
                        {r.input.phone ?? "—"}
                      </td>
                      <td className="px-4 py-2 capitalize text-slate-600">
                        {r.input.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {accepted > PREVIEW_ROWS ? (
              <p className="border-t border-slate-200 px-4 py-2.5 text-sm text-slate-500">
                …and {accepted - PREVIEW_ROWS} more.
              </p>
            ) : null}
          </div>
        ) : null}

        {rejected > 0 ? (
          <div className="overflow-hidden rounded-xl border border-red-200 bg-white">
            <div className="border-b border-red-200 px-4 py-3 text-sm font-medium text-red-700">
              {rejected} row{rejected === 1 ? "" : "s"} will be skipped
            </div>
            <ul className="divide-y divide-slate-200">
              {preview.issues.slice(0, PREVIEW_ISSUES).map((issue) => (
                <li
                  key={`${issue.line}-${issue.message}`}
                  className="flex flex-col gap-0.5 px-4 py-2.5 text-sm sm:flex-row sm:items-baseline sm:gap-3"
                >
                  <span className="shrink-0 text-slate-500">
                    Line {issue.line} · {issue.label}
                  </span>
                  <span className="text-red-600">{issue.message}</span>
                </li>
              ))}
            </ul>
            {rejected > PREVIEW_ISSUES ? (
              <p className="border-t border-slate-200 px-4 py-2.5 text-sm text-slate-500">
                …and {rejected - PREVIEW_ISSUES} more.
              </p>
            ) : null}
            <p className="border-t border-slate-200 px-4 py-2.5 text-sm text-slate-500">
              You can import the {accepted} valid row{accepted === 1 ? "" : "s"} now and
              re-upload a corrected file for the rest — members already on your roster
              are matched by email and never duplicated.
            </p>
          </div>
        ) : null}

        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="csv" value={csv} />
          {state.error ? (
            <p role="alert" className="text-sm text-red-600">
              {state.error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending || accepted === 0}
              className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-base font-medium text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending
                ? "Importing…"
                : `Import ${accepted} member${accepted === 1 ? "" : "s"}`}
            </button>
            <Link
              href="/dashboard/members"
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    );
  }

  // ---- Step 1: choose a file ---------------------------------------------
  const fatal = readError ?? (preview && !preview.ok ? preview.error : null);

  return (
    <div className="flex flex-col gap-5 rounded-xl border border-slate-200 bg-white p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-slate-900">Choose a CSV file</h2>
        <p className="text-sm text-slate-600">
          Export your members from your current system as CSV, then pick the file
          here. You&apos;ll see exactly what will be created before anything is saved.
        </p>
      </div>

      <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
        CSV file
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={onFileChange}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 outline-none transition file:mr-3 file:rounded-md file:border-0 file:bg-brand file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-brand-dark focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </label>

      {fatal ? (
        <p role="alert" className="text-sm text-red-600">
          {fatal}
        </p>
      ) : null}

      {/* A failed import is reported on the preview step, where the confirm
          button lives; it is not repeated here, where it would be stale. */}

      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 text-sm text-slate-600">
        <p className="font-medium text-slate-700">What the file should look like</p>
        <p>
          The first row must be a header row. Only a <strong>name</strong> column is
          required — <code className="text-slate-500">Full name</code>,{" "}
          <code className="text-slate-500">Name</code> and{" "}
          <code className="text-slate-500">Member name</code> are all recognised.
        </p>
        <p>
          Optional columns: {Object.values(COLUMN_LABELS).slice(1).join(", ")}. Anything
          else in the file is ignored. Comma, semicolon and tab separated files all
          work, and up to {IMPORT_MAX_ROWS} members can be imported at a time.
        </p>
        <p>
          Members already on your roster (matched by email) are skipped, so re-running
          an import never creates duplicates.
        </p>
        <a
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`}
          download="alpha-crm-members-template.csv"
          className="w-fit font-medium text-brand hover:underline"
        >
          Download a template CSV
        </a>
      </div>
    </div>
  );
}

/** Compact labelled figure used in the preview / result summaries. */
function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "success" | "warning" | "muted";
}) {
  const valueTone =
    tone === "success"
      ? "text-emerald-600"
      : tone === "warning"
        ? "text-amber-600"
        : tone === "muted"
          ? "text-slate-500"
          : "text-slate-900";
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-slate-100 px-3 py-2.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className={`truncate text-lg font-semibold ${valueTone}`}>{value}</dd>
    </div>
  );
}
