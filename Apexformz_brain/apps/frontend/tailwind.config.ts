import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#0a0f1e",
        foreground: "#ffffff",
        primary: {
          DEFAULT: "#00d4ff",
          foreground: "#0a0f1e",
        },
        secondary: {
          DEFAULT: "#00ff88",
          foreground: "#0a0f1e",
        },
        accent: {
          crypto: "#6e56cf",
          warning: "#ff6b35",
          danger: "#ff4757",
        },
        card: {
          DEFAULT: "rgba(255, 255, 255, 0.05)",
          foreground: "#ffffff",
          border: "rgba(255, 255, 255, 0.1)",
        }
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic": "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },
      animation: {
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(0, 212, 255, 0.2)' },
          '100%': { boxShadow: '0 0 20px rgba(0, 212, 255, 0.6)' },
        }
      }
    },
  },
  plugins: [],
};
export default config;
