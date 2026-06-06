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
        // Chorum brand: indigo, the anchor of the indigo→violet→rose gradient
        // (chorus × quorum — many voices, one signal). Violet accents across the
        // app sit on the gradient's midpoint, so they stay in-family.
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
        },
      },
      boxShadow: {
        glow: "0 10px 40px -10px rgb(79 70 229 / 0.45)",
      },
      backgroundImage: {
        "brand-gradient":
          "linear-gradient(135deg, #4f46e5 0%, #7c3aed 48%, #fb7185 100%)",
        "mesh":
          "radial-gradient(at 20% 0%, rgba(79,70,229,0.15) 0px, transparent 50%), radial-gradient(at 80% 0%, rgba(251,113,133,0.12) 0px, transparent 50%), radial-gradient(at 50% 100%, rgba(124,58,237,0.10) 0px, transparent 50%)",
      },
    },
  },
  plugins: [],
};

export default config;
