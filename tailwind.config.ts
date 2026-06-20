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
        brand: {
          DEFAULT: "#0f766e",
          dark: "#0d5d57",
        },
      },
    },
  },
  plugins: [],
};

export default config;
