import type { Config } from 'tailwindcss';

/**
 * ReviveAI design tokens.
 *
 * The palette is blue-black rather than neutral black: payments tooling sits
 * next to Razorpay's own navy surfaces, and a warm-neutral grey would read as
 * a generic admin template. Hue carries meaning and is never decorative:
 *   azure  -> the product itself, primary actions, "in progress"
 *   mint   -> money that came back
 *   amber  -> money still at risk, needs a human
 *   coral  -> money lost, hard failures
 *   violet -> anything the recovery engine or Copilot produced, not a human
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: '#0A0D14',
        surface: '#101725',
        raised: '#162031',
        overlay: '#1B2638',
        hairline: '#1E2A3D',
        'hairline-strong': '#2A3950',

        content: {
          DEFAULT: '#E8EDF6',
          muted: '#93A1BA',
          faint: '#5F6E8A',
        },

        azure: {
          DEFAULT: '#3D7DFF',
          soft: '#6C9DFF',
          deep: '#2563EB',
          dim: '#16233F',
        },
        mint: { DEFAULT: '#17C79A', soft: '#5BE0BE', dim: '#0E2E2A' },
        amber: { DEFAULT: '#F0A32B', soft: '#F7C46B', dim: '#33270F' },
        coral: { DEFAULT: '#FF5C72', soft: '#FF8D9C', dim: '#3A1520' },
        violet: { DEFAULT: '#8B7BFF', soft: '#B0A5FF', dim: '#211E3D' },
      },

      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },

      fontSize: {
        // Uppercase micro-labels above every panel and column.
        eyebrow: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.11em', fontWeight: '600' }],
        micro: ['0.6875rem', { lineHeight: '1rem' }],
        // Ledger numerals. Tight tracking keeps long rupee figures scannable.
        'data-sm': ['0.8125rem', { lineHeight: '1.25rem', letterSpacing: '-0.01em' }],
        'data-md': ['1.125rem', { lineHeight: '1.5rem', letterSpacing: '-0.02em' }],
        'data-lg': ['1.75rem', { lineHeight: '2rem', letterSpacing: '-0.03em' }],
        'data-xl': ['2.25rem', { lineHeight: '2.5rem', letterSpacing: '-0.035em' }],
      },

      borderRadius: {
        panel: '0.625rem',
        control: '0.375rem',
      },

      boxShadow: {
        // Flat enterprise surfaces: a hairline ring and a low ambient drop,
        // never a blurred translucent card.
        panel: '0 1px 0 0 rgba(255,255,255,0.02) inset, 0 1px 2px 0 rgba(0,0,0,0.4)',
        lift: '0 8px 24px -6px rgba(0,0,0,0.65)',
        drawer: '-16px 0 40px -12px rgba(0,0,0,0.7)',
      },

      spacing: {
        sidebar: '15.5rem',
        topbar: '3.5rem',
      },

      keyframes: {
        'band-grow': {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' },
        },
        'fade-rise': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'live-pulse': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.85)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'band-grow': 'band-grow 720ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-rise': 'fade-rise 240ms ease-out both',
        'slide-in-right': 'slide-in-right 220ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'live-pulse': 'live-pulse 2s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
};

export default config;
