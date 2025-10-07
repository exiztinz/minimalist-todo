# Minimalist Counters (Daily / Weekly / Monthly) — Web App

This is a Vite + React + TypeScript + Tailwind starter containing the app we discussed.
- Per-item targets, progress bar, +1 / -1 buttons
- Section streaks that increment only at real period boundaries
- LocalStorage persistence

## Run locally

1. Install Node.js 18+ from https://nodejs.org/
2. In your terminal:
   ```bash
   npm install
   npm run dev
   ```
3. Open the local URL that Vite prints (usually http://localhost:5173).

## Build for production
```bash
npm run build
npm run preview
```

## Notes
- The app uses `crypto.randomUUID()` for IDs (works in modern browsers).
- Tailwind is configured in `tailwind.config.js`; styles are in `src/index.css`.
