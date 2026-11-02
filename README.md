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


## Brevo delivery-status webhook

This project sends through Brevo's transactional email API. The send API response
means Brevo accepted the message; it does not itself confirm delivery. Delivery
status is updated by Brevo webhook events.

1. Set `BREVO_WEBHOOK_SECRET` in your production environment to a long random value.
2. In Brevo, create a **Transactional** webhook with the URL:
   `https://YOUR_DEPLOYED_HOST/api/webhooks/brevo?token=YOUR_BREVO_WEBHOOK_SECRET`
   Replace both placeholders. Keep the token private.
3. Subscribe the webhook to `Delivered`, `Hard Bounced`, `Soft Bounced`, `Deferred`,
   `Blocked`, and `Error` events.
4. Deploy this app. Recent recipient results will change from `Sent` (Brevo accepted)
   to `Delivered`, `Bounced`, `Deferred`, `Blocked`, or `Failed` when Brevo reports
   the event.

The webhook correlates events by Brevo's `message-id` and recipient email. If an
event arrives before a matching send record is saved, Brevo can retry it; check
Brevo webhook logs when diagnosing missed updates. "Delivered" means the receiving
mail server accepted the message, not that it necessarily landed in the inbox.

Only send campaigns to recipients who explicitly opted in to receive your emails.


## Brevo delivery status tracking (updated)

- Brevo webhook endpoint: `POST /api/webhooks/brevo?token=<BREVO_WEBHOOK_SECRET>`.
- The endpoint validates the configured webhook secret without length-mismatch crashes, matches events using the Brevo message ID and recipient email, and updates delivery statuses.
- Supported event mappings include delivered, hard bounce, soft bounce/deferred, blocked, invalid email, and error.
- Recipient/campaign APIs and dashboard counters now include delivered and bounced/blocked outcomes; the campaign recipient panel briefly polls after sending completes to pick up delayed webhook events.
- Set `BREVO_WEBHOOK_SECRET` in Render and configure a Brevo transactional webhook to the endpoint above. Keep the secret private.
- `sent` indicates Brevo accepted the API request; `delivered` indicates Brevo reported successful delivery. This is not a guarantee that a person opened/read the message.
