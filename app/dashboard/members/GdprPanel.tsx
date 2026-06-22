"use client";

import { useActionState, useState, useTransition } from "react";
import {
  eraseMemberAction,
  exportMemberAction,
  type EraseActionState,
} from "./actions";

/**
 * GDPR data-subject controls on the member detail page (beta-gdpr-001/002).
 *
 * - Export downloads a portable JSON document of the member's personal data.
 *   The Server Action returns the document as a string (a Server Action cannot
 *   stream a file); this component turns it into a browser download.
 * - Erase anonymises the member behind an explicit confirm step, since it is
 *   irreversible. An already-erased member shows a read-only notice instead.
 *
 * Both actions are staff-gated and audit-logged server-side.
 */
export function GdprPanel({
  memberId,
  erased,
}: {
  memberId: string;
  erased: boolean;
}) {
  const [exportError, setExportError] = useState<string | null>(null);
  const [isExporting, startExport] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [eraseState, eraseAction, erasing] = useActionState<
    EraseActionState,
    FormData
  >(eraseMemberAction, {});

  function handleExport() {
    setExportError(null);
    startExport(async () => {
      const result = await exportMemberAction(memberId);
      if (!result.ok) {
        setExportError(result.error);
        return;
      }
      const blob = new Blob([result.json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  const alreadyErased = erased || Boolean(eraseState.success);

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-slate-900">
          Data &amp; privacy (GDPR)
        </h2>
        <p className="text-sm text-slate-600">
          Fulfil a data-subject request: export this member&rsquo;s personal data
          or erase it. Both are recorded in the audit log.
        </p>
      </div>

      {/* Export ------------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleExport}
          disabled={isExporting}
          className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {isExporting ? "Preparing…" : "Export data (JSON)"}
        </button>
        {exportError ? (
          <p role="alert" className="text-sm text-red-600">
            {exportError}
          </p>
        ) : null}
      </div>

      {/* Erase ------------------------------------------------------------- */}
      <div className="border-t border-slate-100 pt-4">
        {alreadyErased ? (
          <p className="text-sm text-slate-500">
            {eraseState.success ??
              "This member has been erased. Their personal data is anonymised."}
          </p>
        ) : confirming ? (
          <form action={eraseAction} className="flex flex-col gap-3">
            <input type="hidden" name="memberId" value={memberId} />
            <p className="text-sm text-red-700">
              This permanently anonymises the member&rsquo;s personal data and
              revokes portal access. It cannot be undone. Continue?
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={erasing}
                className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:opacity-60"
              >
                {erasing ? "Erasing…" : "Yes, erase this member"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={erasing}
                className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex items-center justify-center rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
          >
            Erase member (right to erasure)
          </button>
        )}

        {eraseState.error ? (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {eraseState.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
