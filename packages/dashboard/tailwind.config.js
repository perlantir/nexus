/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        nexus: {
          bg: {
            light: '#FAFAF8',
            dark: '#171614',
          },
          surface: {
            light: '#FFFFFF',
            dark: '#1C1B19',
          },
          'surface-alt': {
            light: '#F5F5F0',
            dark: '#201F1D',
          },
          border: {
            light: '#E5E4DF',
            dark: '#393836',
          },
          text: {
            light: '#1A1A1A',
            dark: '#CDCCCA',
          },
          'text-muted': {
            light: '#6B6B6B',
            dark: '#797876',
          },
          'text-faint': {
            light: '#9B9B9B',
            dark: '#5A5957',
          },
        },
        primary: {
          DEFAULT: '#D97706',
          hover: '#B45309',
          light: '#F59E0B',
        },
        status: {
          active: '#16A34A',
          superseded: '#9B9B9B',
          reverted: '#DC2626',
          pending: '#D97706',
        },
        urgency: {
          critical: '#DC2626',
          high: '#D97706',
          medium: '#6B8AE5',
          low: '#9B9B9B',
        },
        chart: {
          teal: '#20808D',
          terra: '#A84B2F',
          'dark-teal': '#1B474D',
          cyan: '#BCE2E7',
          mauve: '#944454',
          gold: '#FFC553',
          olive: '#848456',
          brown: '#6E522B',
        },
      },
      fontFamily: {
        sans: ['DM Sans', '-apple-system', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '14px',
        xl: '20px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,0.04)',
        md: '0 2px 8px rgba(0,0,0,0.06)',
        lg: '0 4px 16px rgba(0,0,0,0.08)',
      },
      animation: {
        'fade-in': 'fadeIn 200ms ease-out',
        'slide-in': 'slideIn 200ms ease-out',
        'slide-up': 'slideUp 300ms ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        shimmer: 'shimmer 1.5s infinite',
        'page-enter': 'pageEnter 200ms ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideIn: {
          '0%': { opacity: '0', transform: 'translateX(-8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        pageEnter: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
