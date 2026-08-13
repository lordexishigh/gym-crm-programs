"use client";

import { useActionState, useEffect, useRef } from "react";
import { createPlanAction, type PlanFormState } from "./actions";

const initialState: PlanFormState = {};

/**
 * Create-plan form (owner-only page).
 *
 * Presentation-free: rendered inside a `<Modal>` by AddPlanButton, which
 * supplies the card chrome and heading.
 */
export function PlanForm({
  onSuccess,
}: {
  /** Called after a successful add — used by the modal host to close itself. */
  onSuccess?: () => void;
} = {}) {
  const [state, formAction, pending] = useActionState(createPlanAction, initialState);

  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      onSuccess?.();
    }
  }, [state.success, onSuccess]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Plan name
        <input
          type="text"
          name="name"
          required
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder="Unlimited Monthly"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Tier
        <select
          name="tier"
          defaultValue="monthly"
          className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        >
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
          <option value="drop_in">Drop-in</option>
        </select>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Price
          <input
            type="number"
            name="price"
            min="0"
            step="0.01"
            required
            className="rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            placeholder="49.99"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Currency
          <input
            type="text"
            name="currency"
            defaultValue="EUR"
            maxLength={3}
            className="rounded-lg border border-slate-300 px-3 py-2 text-base uppercase outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
        </label>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? "Saving…" : "Add plan"}
      </button>
    </form>
  );
}
