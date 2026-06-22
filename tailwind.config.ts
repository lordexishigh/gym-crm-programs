import type { Config } from "tailwindcss";

/**
 * Mobile-first Tailwind configuration.
 *
 * Tailwind utilities are unprefixed = mobile by default; the breakpoints below
 * are `min-width` (mobile-first), so `sm:`/`md:`/... layer larger screens on top
 * of the base mobile styles. The member portal is designed for the smallest
 * screen first and progressively enhanced for the staff dashboard on desktop.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    // Explicit mobile-first (min-width) breakpoints.
    screens: {
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1536px",
    },
    extend: {
      colors: {
        // Primary brand accent — single source of truth for the app's accent
        // colour. Every `bg-brand` / `text-brand` / `ring-brand` / `border-brand`
        // utility (and the `hover:bg-brand-dark` button state) resolves here, so
        // recolouring the whole UI is a one-place change. Emerald-600 / emerald-700.
        //
        // The channel values live in the `--brand` / `--brand-dark` CSS variables
        // (app/globals.css) so the SAME colour drives both these utilities and the
        // raw-CSS keyboard focus ring — that's the actual single source of truth.
        // `<alpha-value>` keeps opacity modifiers (e.g. `bg-brand/10`) working.
        brand: {
          DEFAULT: "rgb(var(--brand) / <alpha-value>)",
          dark: "rgb(var(--brand-dark) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
