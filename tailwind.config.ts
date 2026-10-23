import type { Config } from 'tailwindcss';

/**
 * Tokens de la estética industrial de De Otro Tiempo.
 * Los colores de línea se usan para identificar Placares y Cocinas en toda la
 * interfaz; el cian queda reservado para foco, estado activo y datos vivos.
 */
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        antracita: '#121416',
        grafito: '#1E2124',
        placares: '#1D63B8',
        cocinas: '#C82333',
        cian: '#22B8CF',
        acero: '#8A939B',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 18px 40px -24px rgba(0,0,0,0.85)',
        glow: '0 0 0 1px rgba(34,184,207,0.25), 0 12px 36px -18px rgba(34,184,207,0.45)',
      },
      backgroundImage: {
        'grid-industrial':
          'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
      },
      backgroundSize: {
        'grid-industrial': '32px 32px',
      },
    },
  },
  plugins: [],
};

export default config;
