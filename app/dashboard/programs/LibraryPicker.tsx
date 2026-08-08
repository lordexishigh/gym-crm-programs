"use client";

import { useMemo, useState } from "react";
import { inputClass, type LibraryItem } from "./builder-model";

/**
 * Exercise-library picker for the program builder: search the gym's library,
 * choose an entry, and insert it as a new editable draft. Owns ONLY the picker
 * state (search text + selection); the draft list itself stays with the parent,
 * which receives the chosen item via `onInsert`. Renders nothing when the gym
 * has no library entries.
 */
export function LibraryPicker({
  library,
  onInsert,
}: {
  library: LibraryItem[];
  /** Called with the chosen library exercise when the trainer inserts it. */
  onInsert: (item: LibraryItem) => void;
}) {
  const [search, setSearch] = useState("");
  // Selection is empty until the trainer picks an entry.
  const [selected, setSelected] = useState("");

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return library;
    return library.filter((l) => l.name.toLowerCase().includes(needle));
  }, [library, search]);

  if (library.length === 0) return null;

  function insert() {
    const item = library.find((l) => l.id === selected);
    if (!item) return;
    onInsert(item);
    setSelected("");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        aria-label="Search the exercise library"
        value={search}
        onChange={(ev) => {
          setSearch(ev.target.value);
          // A narrowed list may no longer contain the selection; reset it so
          // the Insert button can't submit a hidden entry.
          setSelected("");
        }}
        className={`${inputClass} w-36 py-1.5 text-sm`}
        placeholder="Search library…"
      />
      <select
        aria-label="Choose an exercise from the library"
        value={selected}
        onChange={(ev) => setSelected(ev.target.value)}
        className={`${inputClass} py-1.5 text-sm`}
      >
        <option value="">
          {filtered.length === 0 ? "No matches" : "From library…"}
        </option>
        {filtered.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={insert}
        disabled={!selected}
        className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-40"
      >
        Insert
      </button>
    </div>
  );
}
