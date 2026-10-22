# Email Marketing App

Email campaign manager with a Vite + React frontend and Express + MongoDB backend. Campaign delivery uses the Brevo transactional email HTTPS API (not SMTP).

## Setup
1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. Configure `MONGODB_URI`, a random `SESSION_SECRET` (32+ characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `BREVO_API_KEY`, and `BREVO_SENDER_EMAIL`.
4. In Brevo, create an API v3 key and verify/authenticate the sender domain or sender address. Use a sender address authorized in your Brevo account. Configure SPF/DKIM records as instructed by Brevo.
5. Set `APP_BASE_URL` to the public URL where the app is hosted, so unsubscribe links work.
6. Run `npm run dev`. Open **http://localhost:5173**. Vite forwards `/api` and `/unsubscribe` requests to Express on port 6000.

For production, run `npm install`, `npm run build`, then `npm start`. Express serves `dist/` when it exists.

## Render deployment
- Use one Render Web Service for the full-stack app.
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Add the variables from `.env.example` in Render's Environment settings. Do not commit real API keys or secrets.
- Set `APP_BASE_URL` to the public Render service URL.
- Brevo is called over HTTPS, so this avoids Render Free's outbound SMTP port restrictions.

## Sending behaviour
- Each recipient is sent sequentially with at least a 5-second interval between attempts.
- A successful Brevo API response means Brevo accepted the message for processing; it does not guarantee inbox delivery.
- Campaign history, recipient status tracking, pause/resume/cancel controls, unsubscribe links and suppression list remain in place.
- The campaign worker runs inside the Node process. For production workloads, use a durable queue and robust monitoring.
- Only send to people who have consented. Honor unsubscribes and applicable email/privacy laws.
