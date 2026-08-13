"use client";

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

/** Where the chosen theme is persisted. Shared with the pre-paint script. */
export const THEME_STORAGE_KEY = "alpha-crm-theme";

/**
 * Inline script that applies the saved theme BEFORE first paint.
 *
 * Injected in the document head (app/layout.tsx) rather than run from an effect:
 * an effect runs after the first paint, so a light-mode user would see a full
 * dark page flash on every navigation-free load. It is deliberately tiny and
 * dependency-free for the same reason.
 *
 * Note what it does NOT do: consult `prefers-color-scheme`. Dark is this app's
 * deliberate default (the bright-class remap exists because "no white/bright
 * backgrounds" was an explicit request), so the OS preference must not silently
 * flip everyone to light. Light is opt-in, and only an explicit choice persists.
 *
 * Wrapped in try/catch because reading localStorage throws outright in a
 * cookie-blocked or private-mode context, and an exception here would abort the
 * script before the page renders.
 */
export const THEME_INIT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})==="light"){document.documentElement.dataset.theme="light"}}catch(e){}`;

/**
 * Light/dark switch (feedback-2026-08: "light modeeeee").
 *
 * Flips `data-theme` on `<html>`; every colour in the app resolves from the
 * token tables in globals.css keyed off that attribute, so nothing else needs to
 * know a theme changed.
 *
 * Initial state is read in an effect rather than during render, because the
 * server has no way to know what is in the visitor's localStorage. Rendering the
 * dark-default icon on both sides and correcting it after mount keeps hydration
 * consistent; the pre-paint script above means the PAGE itself is already the
 * right colour by then, so only this one icon settles late.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(
      document.documentElement.dataset.theme === "light" ? "light" : "dark",
    );
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    if (next === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable (private mode / blocked cookies). The theme still
      // applies for this page view; it just will not be remembered.
    }
  }

  const nextTheme: Theme = theme === "light" ? "dark" : "light";

  return (
    <button
      type="button"
      onClick={() => apply(nextTheme)}
      // The control is a switch with a persistent state, so it needs both a
      // stable name and its current value announced — an icon-only button would
      // otherwise read as "button" with no indication of what it does.
      aria-label={`Switch to ${nextTheme} theme`}
      title={`Switch to ${nextTheme} theme`}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
    >
      {theme === "light" ? <IconMoon /> : <IconSun />}
    </button>
  );
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Shown while dark is active — the control switches TO light. */
function IconSun() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

/** Shown while light is active — the control switches TO dark. */
function IconMoon() {
  return (
    <svg {...iconProps}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}
