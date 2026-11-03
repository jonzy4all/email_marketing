# Email Marketing App — Amazon SES

Email campaign manager with a Vite + React frontend and Express + MongoDB backend. Campaign delivery uses **Amazon Simple Email Service (SES) through AWS SDK for JavaScript v3**. Delivery events are sent by SES to **Amazon SNS**, which posts them to the app's HTTPS webhook.

## 1. Requirements

- Node.js 20 or later
- MongoDB / MongoDB Atlas
- An AWS account with Amazon SES enabled in the same region used by this app
- A verified SES sender identity (domain verification is recommended)
- SES production access if you intend to send to recipients who are not verified in your AWS account

## 2. Install and configure the application

1. Run `npm install` (this creates a fresh `package-lock.json` containing the SES/SNS dependencies).
2. Copy `.env.example` to `.env`.
3. Configure `MONGODB_URI`, a random `SESSION_SECRET` (32+ characters), `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
4. Set `AWS_REGION` to the SES region where your sender identity is verified (for example, `eu-north-1`). SES identities, configuration sets, and SNS topics are regional resources; keep them in the same region.
5. Set `EMAIL_FROM` to an address at your verified domain, for example `info@your-domain.com`.
6. Set `EMAIL_FROM_NAME`, optional `EMAIL_REPLY_TO`, and `APP_BASE_URL` to the deployed public URL so unsubscribe links work.
7. Set `SES_CONFIGURATION_SET` and `SNS_TOPIC_ARN` after completing the AWS steps below.
8. Provide AWS credentials using the standard AWS SDK credential provider chain. For local development, use an IAM user's credentials in `.env` or the AWS shared credentials profile. For production, prefer an attached IAM role / workload identity where your hosting platform supports it. Never commit credentials.
9. Run `npm run dev`; open `http://localhost:5173`. Vite forwards `/api` and `/unsubscribe` to Express on port 6000.

### IAM permissions

The runtime identity needs permission to send through SES, ideally scoped to the intended verified identity and configuration set. A minimal starting action is `ses:SendEmail` on the SES identity ARN in the selected region. Do not use root-account access keys. SES sending is performed over HTTPS; SMTP credentials and SMTP ports are not used.

## 3. Amazon SES setup (console)

1. Open the [Amazon SES console](https://console.aws.amazon.com/ses/) and select the same AWS region as `AWS_REGION` (e.g. `eu-north-1`).
2. Under **Configuration → Verified identities**, confirm that your sending domain is verified. If it is not, choose **Create identity → Domain**, enter your domain, and publish the SES-provided DNS verification and DKIM records at your DNS provider. Wait until SES reports the identity and DKIM as verified.
3. Ensure the domain has appropriate SPF and DMARC DNS records. Publish the exact SES DKIM records SES provides; do not invent or reuse records from another region/account. Avoid creating multiple conflicting SPF records—merge authorized senders into one SPF TXT record.
4. In SES **Account dashboard**, check whether the account is still in the sandbox. If it is, request production access for the selected region. Until production access is granted, sending is restricted to verified recipients / the mailbox simulator and the sandbox sending quota applies.
5. Verify the exact `EMAIL_FROM` address or ensure it belongs to the verified domain.
6. Create an IAM identity for the application with least-privilege SES send permission. Configure credentials using the AWS SDK provider chain. On Render, use a supported IAM role integration if available; otherwise use encrypted environment variables and rotate them periodically.

AWS documentation: [SES identity verification](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html), [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [JavaScript v3 send example](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/ses-examples-sending-email.html).

## 4. Configure SES delivery-event publishing (SNS webhook)

This app's endpoint is `POST /api/webhooks/ses`. It validates the SNS message signature and checks the exact topic ARN before accepting events. It also handles SNS's initial subscription confirmation.

### A. Create an SNS topic

1. Open the [Amazon SNS console](https://console.aws.amazon.com/sns/) in the same region as SES.
2. Choose **Topics → Create topic**.
3. Select **Standard** (SES event publishing does not support FIFO topics).
4. Name it, for example `email-marketing-ses-events`, and create it.
5. Copy its ARN into the app's `SNS_TOPIC_ARN` environment variable. Example format: `arn:aws:sns:eu-north-1:123456789012:email-marketing-ses-events`.

### B. Create an SES configuration set and SNS event destination

1. In the SES console, open **Configuration → Configuration sets → Create set**.
2. Name it `email-marketing-events` (or another name) and create it.
3. Open that configuration set and choose **Event destinations → Add destination**.
4. Name the destination `sns-webhook`, enable event publishing, and select **Amazon SNS** as the destination type.
5. Select the SNS Standard topic created above.
6. Enable these event types: **Send, Delivery, Bounce, Complaint, Reject, and Delivery delay**. Open and Click can be enabled later if you add engagement tracking.
7. Save the destination.
8. Ensure the SNS topic access policy permits `ses.amazonaws.com` to call `sns:Publish` for this configuration set. The SES console's event-destination flow may guide you through adding the permission. Restrict the policy to your AWS account and configuration-set ARN as shown in the [AWS SNS event-destination guide](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html).
9. Set `SES_CONFIGURATION_SET=email-marketing-events` in the app environment. The backend includes this configuration set on each SES send; without it, this event destination will not receive the app's events.

### C. Subscribe the app's HTTPS endpoint to SNS

1. Deploy the app so it has a public HTTPS URL.
2. In SNS, open the topic → **Subscriptions → Create subscription**.
3. Select **HTTPS** as the protocol.
4. Enter `https://YOUR_DEPLOYED_HOST/api/webhooks/ses` as the endpoint and create the subscription.
5. SNS sends a `SubscriptionConfirmation` message to the endpoint. The application validates its signature and automatically fetches the signed AWS `SubscribeURL` to confirm it.
6. Return to SNS **Subscriptions** and confirm the subscription status is no longer `PendingConfirmation`.
7. Set `SNS_TOPIC_ARN` in the deployed app environment to the exact topic ARN, then redeploy/restart.

AWS documentation: [SES event publishing overview](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-using-event-publishing.html), [SNS event destination](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html), [SNS HTTPS subscription](https://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.subscribe.html), [SNS signature verification](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).

## 5. Environment variables

Required/important settings:

```dotenv
AWS_REGION=eu-north-1
AWS_ACCESS_KEY_ID=your-iam-access-key-id
AWS_SECRET_ACCESS_KEY=your-iam-secret-access-key
SES_CONFIGURATION_SET=email-marketing-events
EMAIL_FROM=info@your-verified-domain.com
SNS_TOPIC_ARN=arn:aws:sns:eu-north-1:123456789012:email-marketing-ses-events
SES_API_TIMEOUT_MS=20000
```

For production, do not commit `.env`; add the values in your hosting provider's encrypted environment settings. Use an IAM role instead of long-lived keys whenever possible. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are optional when the environment supplies AWS credentials through an IAM role or shared profile.

## 6. Deploy on Render

- Use one Render Web Service for the full-stack app.
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Add the environment variables described above in Render's Environment settings.
- Set `APP_BASE_URL` to the public Render service URL.
- Make sure the SNS HTTPS subscription uses that exact public host and `/api/webhooks/ses` path.
- SES uses HTTPS API calls, so the app does not need outbound SMTP ports.

## 7. Delivery tracking behaviour

- `sent` means SES accepted the send request and returned a MessageId; it does **not** mean inbox delivery.
- SNS events update recipients to `delivered`, `bounced`, `deferred`, `complained`, or `rejected`.
- A transient SES bounce is recorded as `deferred`; permanent bounces are recorded as `bounced`.
- SNS notifications are signature-validated and restricted to `SNS_TOPIC_ARN`.
- The database stores the SES MessageId in `providerMessageId`. Historical Brevo message IDs remain readable for old campaign records, but all new sending uses SES.
- A delivery event means the receiving mail server accepted the message; it does not prove that the email reached the inbox or was opened/read.

## 8. Sending behaviour and compliance

- Each recipient is sent sequentially with the configured delay (`EMAIL_DELAY_MS`, default 10 seconds; minimum 10 seconds in the server code).
- Campaign history, recipient tracking, pause/resume/cancel controls, unsubscribe links and the suppression list remain in place.
- The campaign worker currently runs inside the Node process. For production-scale workloads, use a durable queue and robust monitoring so work can recover after a restart.
- Only send to people who explicitly opted in. Honor unsubscribes, complaints, and applicable email/privacy laws. Do not re-add complained or unsubscribed recipients to marketing lists.

## 9. Troubleshooting checklist

- **Message not sent:** check Render logs for SES errors, confirm `AWS_REGION`, IAM `ses:SendEmail` permission, `EMAIL_FROM`, identity verification, and SES sandbox/production status.
- **Sent but no delivery status:** confirm `SES_CONFIGURATION_SET` exactly matches the configuration set, the SNS destination is enabled, the SNS topic ARN matches `SNS_TOPIC_ARN`, and the SNS subscription is confirmed.
- **Webhook returns 403:** the incoming topic ARN does not match `SNS_TOPIC_ARN`.
- **Webhook returns 400:** inspect SNS delivery logs and verify the request reached the correct HTTPS endpoint with an unmodified SNS payload.
- **No events for sends:** ensure the backend was restarted after setting `SES_CONFIGURATION_SET`; all app messages must be sent with that configuration set.
