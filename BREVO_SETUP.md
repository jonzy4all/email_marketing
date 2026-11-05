# Brevo transactional email and webhook setup

This application sends campaign messages through Brevo's transactional email API (`POST https://api.brevo.com/v3/smtp/email`). Delivery notifications must be configured as **transactional** webhooks in Brevo.

## Render environment variables

Set these in the Render service's Environment tab:

- `BREVO_API_KEY`: the API key generated in Brevo (not an SMTP key).
- `BREVO_SENDER_EMAIL`: an email address verified/authorized as a sender in Brevo.
- `BREVO_WEBHOOK_SECRET`: a long random secret of at least 32 characters. Generate a different value for production; do not commit it to Git or share it publicly.
- `APP_BASE_URL`: the public base URL of this application, without a trailing slash.
- `MONGODB_URI`, `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`: retain the application's existing required settings.

After changing environment variables, redeploy/restart the Render service.

## Configure the Brevo webhook

Create a **transactional** webhook in Brevo and use this URL, replacing the token placeholder with the exact value of `BREVO_WEBHOOK_SECRET` configured in Render:

`https://email-marketing-a63n.onrender.com/api/webhooks/brevo?token=YOUR_BREVO_WEBHOOK_SECRET`

If your Render service has a different public hostname, use that hostname instead. Enable the transactional delivery events offered in your Brevo account, especially delivered, hard bounce, soft bounce, blocked, invalid, deferred, and error. Enable spam/complaint and unsubscribe events too if those are available for your webhook configuration.

The webhook route is registered before the browser same-origin middleware and validates the shared token using a timing-safe comparison. Do not remove the token check or expose the token in client-side code.

## What the webhook updates

- `delivered` updates the campaign recipient to `delivered`.
- `hardBounce` / `hard_bounce` updates it to `bounced`.
- `softBounce` / `soft_bounce` and `deferred` update it to `deferred`.
- `blocked`, `invalid`, `invalid_email`, and `error` update the corresponding recipient status.
- `spam`, `complaint`, `unsubscribe`, and `unsubscribed` add the address to the suppression collection so later campaigns skip it.

The send API response only means Brevo accepted the send request. It does not prove delivery. A recipient remains `sent` until a matching delivery event arrives. Matching uses the Brevo message ID and recipient email address.

## Verification

1. In Brevo, confirm the sender is verified and transactional sending is enabled for the account.
2. Send a test campaign to an inbox you control.
3. In Brevo, open Transactional logs and inspect the message. Check whether it is delivered, deferred, blocked, or bounced.
4. In the Render service logs, look for `Brevo delivery event processed.` or a warning explaining why an event did not match.
5. Confirm the recipient status in the application changes from `sent` to the final event status.

A webhook test that has no message ID can confirm that the endpoint responds, but it cannot update a campaign recipient. Use a real transactional message to verify database matching.
