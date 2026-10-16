# Email Marketing App

Email campaign manager with a **Vite + React frontend** and an **Express + MongoDB + Nodemailer backend**. The existing campaign workflows are preserved while the UI is migrated into a Vite-managed React entry point.

## Requirements
- Node.js 18+ (current LTS recommended)
- MongoDB local or MongoDB Atlas
- SMTP credentials for a provider that permits the intended volume and use

## Setup
1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. Configure `MONGODB_URI`, a random `SESSION_SECRET` (32+ characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 8 characters), `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and `APP_BASE_URL`.
4. Run `npm run dev`.
5. Open **http://localhost:5173**. Vite forwards `/api` and `/unsubscribe` requests to the Express server on port 6000.

For production, run `npm run build` then `npm start`. Express serves `dist/` when it exists. If `dist/` does not exist, it falls back to the legacy `public/` folder.

## Sign-in troubleshooting
- Sign in with the exact `ADMIN_EMAIL` and `ADMIN_PASSWORD` configured in `.env` (not SMTP credentials unless they happen to be the same).
- The backend creates the initial administrator on first startup. If the account already exists, changing `ADMIN_PASSWORD` in `.env` does **not** update the stored hash; reset the account securely in MongoDB if needed.
- The server currently verifies MongoDB and SMTP before it begins listening. If either connection fails, the API never starts and sign-in cannot work. Check the terminal for `Startup failed`, `MongoDB connection failed`, or `SMTP connection failed`.
- In development, use the Vite URL on port 5173. Opening an HTML file directly (`file://`) bypasses the Vite proxy and causes relative API calls to fail.
- If login reports a request error, check that both processes started and that the backend is reachable at `http://localhost:6000/api/session`.
- The login endpoint is rate-limited after repeated attempts. Wait for the window to expire before retrying.

## Included workflows
- Admin sign-in with bcrypt password hashing and MongoDB sessions.
- Compose campaign and upload a TXT file of leads (up to 1 MB).
- Validate and deduplicate recipient addresses.
- Sequential sending with a minimum 10-second interval.
- Campaign history, live status, pause/resume/cancel controls, and recipient results.
- Unsubscribe links and suppression list; unsubscribed addresses are skipped.

## Important notes
Only send marketing messages to people who have consented. Honor unsubscribes and applicable email/privacy laws. This starter keeps the campaign worker in the Node process, so production deployments should add durable queue recovery, robust monitoring, HTTPS, and a proper one-click unsubscribe implementation where required.

## Project structure
- `src/main.jsx` — React entry point
- `src/legacyMarkup.html` — current dashboard markup mounted by React
- `src/legacy.js` — existing campaign interactions (preserved during migration)
- `src/style.css` — responsive styles
- `vite.config.js` — Vite config and API proxy
- `server.js` — Express API, authentication, sessions, campaign worker
- `dist/` — generated production frontend (created by `npm run build`)
