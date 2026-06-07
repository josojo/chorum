import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        // The layout loads Inter via next/font and wires it through this var.
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: [
          "var(--font-inter)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
      },
      colors: {
        // Chorum brand: violet, the anchor of the violet→teal→emerald gradient
        // (many voices, one signal — "hear + earth"). Teal bridges violet→green
        // so they stop fighting; accents across the app sit on this scale.
        brand: {
          50: "#f5f3ff",
          100: "#ede9fe",
          200: "#ddd6fe",
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#8b5cf6",
          600: "#7c3aed",
          700: "#6d28d9",
          800: "#5b21b6",
          900: "#4c1d95",
        },
      },
      boxShadow: {
        glow: "0 10px 40px -10px rgb(13 148 136 / 0.5)",
      },
      backgroundImage: {
        "brand-gradient":
          "linear-gradient(120deg, #7c3aed 0%, #0d9488 55%, #10b981 100%)",
        "mesh":
          "radial-gradient(at 20% 0%, rgba(124,58,237,0.13) 0px, transparent 50%), radial-gradient(at 80% 0%, rgba(13,148,136,0.12) 0px, transparent 50%), radial-gradient(at 50% 100%, rgba(16,185,129,0.10) 0px, transparent 50%)",
      },
    },
  },
  plugins: [],
};

export default config;
