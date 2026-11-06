require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
// const nodemailer = require("nodemailer");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 6000);
const DELAY_MS = Math.max(10000, Number(process.env.EMAIL_DELAY_MS || 5000));
const MAX_RECIPIENTS = Math.min(5000, Math.max(1, Number(process.env.MAX_RECIPIENTS_PER_CAMPAIGN || 5000)));
const MAX_LEADS_BYTES = Number(process.env.MAX_LEADS_FILE_BYTES || 1048576);
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

const recipientSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  status: { type: String, enum: ["pending", "sending", "sent", "delivered", "deferred", "bounced", "blocked", "failed", "skipped"], default: "pending" },
  error: { type: String, default: "" },
  brevoMessageId: { type: String, default: "", index: true },
  sentAt: { type: Date, default: null },
  deliveryAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  unsubscribeToken: { type: String, default: "" }
}, { _id: true });

const campaignSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  from: { type: String, required: true },
  fromName: { type: String, default: "Email Marketing" },
  replyTo: { type: String, default: "" },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  recipients: [recipientSchema],
  status: { type: String, enum: ["queued", "sending", "paused", "completed", "failed", "cancelled"], default: "queued" },
  startedAt: Date,
  completedAt: Date,
  lastError: { type: String, default: "" }
}, { timestamps: true });
const Campaign = mongoose.model("Campaign", campaignSchema);

const suppressionSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  reason: { type: String, default: "unsubscribed" },
  createdAt: { type: Date, default: Date.now }
});
const Suppression = mongoose.model("Suppression", suppressionSchema);

const brevoApiKey = String(process.env.BREVO_API_KEY || "").trim();
const configuredFromEmail = normalizeEmail(process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_FROM);

const configuredFromName = String(process.env.EMAIL_FROM_NAME || "Email Marketing").trim().slice(0, 100);
const configuredReplyTo = normalizeEmail(process.env.EMAIL_REPLY_TO);

app.use(session({
  name: "email_marketing.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in to continue." });
  next();
}
function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "Cross-origin request blocked." });
    } catch {
      return res.status(403).json({ error: "Invalid request origin." });
    }
  }
  next();
}
// Brevo transactional delivery events. Configure this exact route in Brevo.
// The shared query token is an application-level safeguard; it is not a Brevo API key.
app.post("/api/webhooks/brevo", async (req, res) => {
  const expectedSecret = String(process.env.BREVO_WEBHOOK_SECRET || "");
  const suppliedSecret = String(req.query.token || "");
  const expected = Buffer.from(expectedSecret);
  const supplied = Buffer.from(suppliedSecret);

  if (!expected.length || !supplied.length || expected.length !== supplied.length ||
      !crypto.timingSafeEqual(expected, supplied)) {
    console.warn("Brevo webhook rejected: missing or invalid token.");
    return res.status(401).json({ error: "Unauthorized webhook." });
  }

  const event = req.body && typeof req.body === "object" ? req.body : {};
  const messageId = String(event["message-id"] || event.messageId || "").trim();
  const email = normalizeEmail(event.email);
  // Brevo event names include camelCase values such as hardBounce/softBounce.
  // Lowercasing them gives hardbounce/softbounce, so aliases are included below.
  const eventName = String(event.event || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const reason = String(event.reason || event.error || "").trim().slice(0, 350);

  if (!email || !eventName) {
    console.info("Brevo webhook received an incomplete event.", { event: eventName || "unknown" });
    return res.status(200).json({ received: true, ignored: true, reason: "Missing email or event." });
  }

  // Complaints and unsubscribe events may not include a message ID. Suppress
  // these addresses even when there is no campaign recipient to match.
  const suppressionEvents = ["spam", "complaint", "unsubscribe", "unsubscribed"];
  if (suppressionEvents.includes(eventName)) {
    try {
      await Suppression.updateOne(
        { email },
        { $set: { reason: eventName === "spam" || eventName === "complaint" ? "spam_complaint" : "unsubscribed" } },
        { upsert: true }
      );
      console.info("Brevo suppression event recorded.", { event: eventName, email });
      return res.status(200).json({ received: true, suppressed: true });
    } catch (err) {
      console.error("Brevo suppression webhook failed:", safeError(err));
      return res.status(500).json({ error: "Webhook processing failed." });
    }
  }

  const eventMap = {
    delivered: { status: "delivered", error: "", final: true },
    hardbounce: { status: "bounced", error: reason || "Permanent bounce", final: true },
    hard_bounce: { status: "bounced", error: reason || "Permanent bounce", final: true },
    softbounce: { status: "deferred", error: reason || "Temporary bounce", final: false },
    soft_bounce: { status: "deferred", error: reason || "Temporary bounce", final: false },
    deferred: { status: "deferred", error: reason || "Delivery deferred", final: false },
    blocked: { status: "blocked", error: reason || "Brevo or the receiving server blocked this email.", final: true },
    invalid_email: { status: "bounced", error: reason || "Brevo reported an invalid email address.", final: true },
    invalid: { status: "bounced", error: reason || "Brevo reported an invalid email address.", final: true },
    error: { status: "failed", error: reason || "Brevo reported a delivery error.", final: true }
  };
  const mapped = eventMap[eventName];
  if (!mapped) {
    console.info("Brevo webhook event acknowledged but not used for delivery status.", { event: eventName });
    return res.status(200).json({ received: true, ignored: true, event: eventName });
  }
  if (!messageId) {
    console.info("Brevo delivery event has no message ID.", { event: eventName, email });
    return res.status(200).json({ received: true, matched: false, reason: "Missing message ID." });
  }

  try {
    const campaign = await Campaign.findOne({ "recipients.brevoMessageId": messageId });
    if (!campaign) {
      console.warn("Brevo event did not match a campaign message ID.", { event: eventName, messageId });
      return res.status(200).json({ received: true, matched: false });
    }

    const recipient = campaign.recipients.find(r =>
      String(r.brevoMessageId || "").trim() === messageId && normalizeEmail(r.email) === email
    );
    if (!recipient) return res.status(200).json({ received: true, matched: false });

    const eventSeconds = Number(event.ts_event || event.ts || 0);
    const eventDate = Number.isFinite(eventSeconds) && eventSeconds > 0
      ? new Date(eventSeconds * 1000)
      : new Date();
    const existingFinal = ["delivered", "bounced", "blocked"].includes(recipient.status);
    const currentTime = recipient.deliveryAt ? new Date(recipient.deliveryAt).getTime() : 0;
    const incomingTime = eventDate.getTime();

    // A later delivered event can supersede a prior transient/final negative
    // state; older events must not overwrite a newer outcome.
    const shouldApply = !existingFinal ||
      (mapped.status === "delivered" && recipient.status !== "delivered" &&
       (!currentTime || incomingTime >= currentTime));
    if (shouldApply && (!recipient.deliveryAt || incomingTime >= currentTime || mapped.status === "delivered")) {
      recipient.status = mapped.status;
      recipient.error = mapped.error;
      recipient.deliveryAt = eventDate;
      await campaign.save();
    }

    console.info("Brevo delivery event processed.", { event: eventName, email, status: recipient.status });
    return res.status(200).json({ received: true, matched: true, status: recipient.status });
  } catch (err) {
    console.error("Brevo webhook processing failed:", safeError(err));
    return res.status(500).json({ error: "Webhook processing failed." });
  }
});

// Apply same-origin protection to browser-facing API routes. The Brevo webhook
// is registered above and is protected by its dedicated shared token instead.
app.use("/api", requireSameOrigin);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function safeError(error) {
  return String(error && error.message ? error.message : "Email delivery failed").slice(0, 350);
}

app.get("/api/config", (req, res) => {
  res.json({
    sender: configuredFromEmail,
    fromName: configuredFromName,
    replyTo: configuredReplyTo
  });
});

app.get("/api/session", async (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  const user = await User.findById(req.session.userId).select("email").lean();
  if (!user) {
    req.session.destroy(() => {});
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, email: user.email });
});

app.post("/api/login", loginLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  if (!emailRegex.test(email) || !password || password.length > 200) {
    return res.status(400).json({ error: "Enter a valid email and password." });
  }
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Unable to start session." });
    req.session.userId = user._id.toString();
    req.session.email = user.email;
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).json({ error: "Unable to save session." });
      res.json({ authenticated: true, email: user.email });
    });
  });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Unable to log out." });
    res.clearCookie("email_marketing.sid");
    res.json({ success: true });
  });
});

app.get("/api/dashboard", requireAuth, async (req, res) => {
  const owner = req.session.userId;
  const [campaigns, suppressedCount] = await Promise.all([
    Campaign.find({ owner }).sort({ createdAt: -1 }).limit(50)
      .select("from subject status recipients createdAt completedAt").lean(),
    Suppression.countDocuments({})
  ]);
  const summaries = campaigns.map(c => {
    const sent = c.recipients.filter(r => ["sent", "delivered", "deferred", "bounced", "blocked"].includes(r.status)).length;
    const delivered = c.recipients.filter(r => r.status === "delivered").length;
    const bounced = c.recipients.filter(r => ["bounced", "blocked"].includes(r.status)).length;
    const failed = c.recipients.filter(r => r.status === "failed").length;
    const skipped = c.recipients.filter(r => r.status === "skipped").length;
    return {
      id: c._id,
      subject: c.subject,
      status: c.status,
      total: c.recipients.length,
      sent, delivered, bounced, failed, skipped,
      pending: c.recipients.filter(r => ["pending", "sending"].includes(r.status)).length,
      createdAt: c.createdAt,
      completedAt: c.completedAt
    };
  });
  res.json({ campaigns: summaries, suppressedCount });
});

app.get("/api/unsubscribes", requireAuth, async (req, res) => {
  const rows = await Suppression.find({}).sort({ createdAt: -1 }).limit(500).lean();
  res.json({ unsubscribes: rows.map(r => ({ email: r.email, reason: r.reason, createdAt: r.createdAt })) });
});

app.post("/api/campaigns", requireAuth, async (req, res) => {
  const from = normalizeEmail(req.body.from);
  const fromName = String(req.body.fromName || configuredFromName).trim();
  const replyTo = normalizeEmail(req.body.replyTo);
  const subject = String(req.body.subject || "").trim();
  const message = String(req.body.message || "").trim();
  let recipients = Array.isArray(req.body.recipients) ? req.body.recipients.map(normalizeEmail) : [];

  if (!emailRegex.test(from) || from !== configuredFromEmail) {
    return res.status(400).json({ error: "From email must match the configured EMAIL_FROM address." });
  }
  
if (!fromName || fromName.length > 100 || /[\r\n]/.test(fromName)) {
  return res.status(400).json({
    error: "Enter a valid From name (maximum 100 characters)."
  });
}

  if (replyTo && !emailRegex.test(replyTo)) {
    return res.status(400).json({ error: "Enter a valid Reply-To email address or leave it blank." });
  }
  if (!subject || subject.length > 200 || !message || message.length > 100000) {
    return res.status(400).json({ error: "Subject is required (maximum 200 characters) and message is required." });
  }
  if (!recipients.length) return res.status(400).json({ error: "Enter a recipient or upload a leads file." });
  if (recipients.length > MAX_RECIPIENTS) {
    return res.status(400).json({ error: `Maximum ${MAX_RECIPIENTS} recipients per campaign.` });
  }
  if (recipients.some(email => !emailRegex.test(email))) {
    return res.status(400).json({ error: "One or more recipient email addresses are invalid." });
  }

  recipients = [...new Set(recipients)];
  const suppressed = new Set((await Suppression.find({ email: { $in: recipients } }).select("email").lean()).map(r => r.email));
  const recipientDocs = recipients.map(email => ({
    email,
    status: suppressed.has(email) ? "skipped" : "pending",
    error: suppressed.has(email) ? "Recipient has unsubscribed." : "",
    unsubscribeToken: crypto.randomBytes(24).toString("hex")
  }));

  if (!recipientDocs.some(r => r.status === "pending")) {
    return res.status(400).json({ error: "All supplied recipients are unsubscribed." });
  }

  const campaign = await Campaign.create({
    owner: req.session.userId, from, fromName, replyTo, subject, message, recipients: recipientDocs, status: "queued"
  });

  res.status(202).json({ campaignId: campaign._id, message: "Campaign queued." });
  runCampaign(campaign._id.toString()).catch(err => console.error("Campaign worker:", err));
});

const running = new Set();
const paused = new Set();
const cancelled = new Set();

async function runCampaign(campaignId) {
  if (running.has(campaignId)) return;
  running.add(campaignId);
  try {
    let campaign = await Campaign.findById(campaignId);
    if (!campaign || !["queued", "sending"].includes(campaign.status)) return;
    campaign.status = "sending";
    campaign.startedAt = campaign.startedAt || new Date();
    await campaign.save();

    for (let i = 0; i < campaign.recipients.length; i++) {
      if (cancelled.has(campaignId)) {
        campaign.status = "cancelled";
        campaign.completedAt = new Date();
        await campaign.save();
        return;
      }
      while (paused.has(campaignId)) {
        await wait(500);
        if (cancelled.has(campaignId)) break;
      }
      if (cancelled.has(campaignId)) continue;

      campaign = await Campaign.findById(campaignId);
      if (!campaign) return;
      const recipient = campaign.recipients[i];
      if (!recipient || recipient.status !== "pending") continue;

      // Recheck suppression immediately before each send.
      const isSuppressed = await Suppression.exists({ email: recipient.email });
      if (isSuppressed) {
        recipient.status = "skipped";
        recipient.error = "Recipient has unsubscribed.";
        await campaign.save();
        continue;
      }

      recipient.status = "sending";
      recipient.attempts += 1;
      await campaign.save();

      const baseUrl = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
      const unsubscribeUrl = `${baseUrl}/unsubscribe/${recipient.unsubscribeToken}`;

      try {
        if (!brevoApiKey) {
          throw new Error("BREVO_API_KEY is not configured on the server.");
        }
        const brevoPayload = {
          sender: { name: campaign.fromName || configuredFromName, email: campaign.from },
          to: [{ email: recipient.email }],
          subject: campaign.subject,
          textContent: String(campaign.message),
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
          }
        };
        if (campaign.replyTo) brevoPayload.replyTo = { email: campaign.replyTo };
        const brevoResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "accept": "application/json",
            "api-key": brevoApiKey,
            "content-type": "application/json"
          },
          body: JSON.stringify(brevoPayload),
          signal: AbortSignal.timeout(Number(process.env.BREVO_API_TIMEOUT_MS || 20000))
        });
        if (!brevoResponse.ok) {
          const responseText = await brevoResponse.text();
          let detail = responseText;
          try {
            const parsed = JSON.parse(responseText);
            detail = parsed.message || parsed.code || responseText;
          } catch {}
          throw new Error(`Brevo API ${brevoResponse.status}: ${String(detail).slice(0, 250)}`);
        }
        const brevoResult = await brevoResponse.json().catch(() => ({}));
        recipient.status = "sent";
        recipient.brevoMessageId = String(brevoResult.messageId || "").trim();
        recipient.sentAt = new Date();
        recipient.error = "";
      } catch (err) {
        recipient.status = "failed";
        recipient.error = safeError(err);
      }
      await campaign.save();

      // Five seconds after each attempt before moving to the next recipient.
      if (i < campaign.recipients.length - 1) await wait(DELAY_MS);
    }

    campaign = await Campaign.findById(campaignId);
    if (campaign && !["cancelled"].includes(campaign.status)) {
      campaign.status = cancelled.has(campaignId) ? "cancelled" : "completed";
      campaign.completedAt = new Date();
      await campaign.save();
    }
  } catch (err) {
    console.error("Campaign worker failed:", err);
    await Campaign.updateOne({ _id: campaignId }, { $set: { status: "failed", lastError: safeError(err), completedAt: new Date() } });
  } finally {
    running.delete(campaignId);
    paused.delete(campaignId);
    cancelled.delete(campaignId);
  }
}

function ownedCampaign(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid campaign ID." });
  Campaign.findOne({ _id: req.params.id, owner: req.session.userId }).then(campaign => {
    if (!campaign) return res.status(404).json({ error: "Campaign not found." });
    req.campaign = campaign;
    next();
  }).catch(next);
}

app.get("/api/campaigns/:id", requireAuth, ownedCampaign, (req, res) => {
  const c = req.campaign;
  const sent = c.recipients.filter(r => ["sent", "delivered", "deferred", "bounced", "blocked"].includes(r.status)).length;
  const delivered = c.recipients.filter(r => r.status === "delivered").length;
  const bounced = c.recipients.filter(r => ["bounced", "blocked"].includes(r.status)).length;
  const failed = c.recipients.filter(r => r.status === "failed").length;
  const skipped = c.recipients.filter(r => r.status === "skipped").length;
  res.json({
    id: c._id, status: c.status, total: c.recipients.length, sent, delivered, bounced, failed, skipped,
    pending: c.recipients.filter(r => ["pending", "sending"].includes(r.status)).length,
    recipients: c.recipients.map(r => ({
      email: r.email, status: r.status, error: r.error, attempts: r.attempts,
      sentAt: r.sentAt, deliveryAt: r.deliveryAt
    }))
  });
});

app.post("/api/campaigns/:id/pause", requireAuth, ownedCampaign, (req, res) => {
  if (!running.has(req.params.id)) return res.status(400).json({ error: "Campaign is not currently running." });
  paused.add(req.params.id);
  Campaign.updateOne({ _id: req.params.id, owner: req.session.userId }, { $set: { status: "paused" } }).catch(console.error);
  res.json({ success: true, status: "paused" });
});

app.post("/api/campaigns/:id/resume", requireAuth, ownedCampaign, (req, res) => {
  if (!running.has(req.params.id)) {
    if (req.campaign.status !== "paused") return res.status(400).json({ error: "Campaign is not paused." });
    paused.delete(req.params.id);
    return res.status(409).json({ error: "This starter cannot recover a worker after a server restart. Use a persistent queue in production." });
  }
  paused.delete(req.params.id);
  Campaign.updateOne({ _id: req.params.id, owner: req.session.userId }, { $set: { status: "sending" } }).catch(console.error);
  res.json({ success: true, status: "sending" });
});

app.post("/api/campaigns/:id/cancel", requireAuth, ownedCampaign, (req, res) => {
  cancelled.add(req.params.id);
  paused.delete(req.params.id);
  res.json({ success: true, status: "cancelling" });
});

app.get("/unsubscribe/:token", async (req, res) => {
  const token = String(req.params.token || "");
  if (!/^[a-f0-9]{48}$/.test(token)) return res.status(400).send("Invalid unsubscribe link.");
  const recipient = await Campaign.findOne({ "recipients.unsubscribeToken": token });
  if (!recipient) return res.status(404).send("Unsubscribe link not found.");
  const email = recipient.recipients.find(r => r.unsubscribeToken === token)?.email;
  if (!email) return res.status(404).send("Unsubscribe link not found.");
  await Suppression.updateOne({ email }, { $set: { email, reason: "unsubscribed" } }, { upsert: true });
  res.send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribed</title><body style="font:16px Arial;max-width:600px;margin:60px auto;padding:20px"><h1>You have been unsubscribed</h1><p>${email.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]))} will not be included in future campaigns from this application.</p></body></html>`);
});

// Serve the Vite production build when present; retain the old public page as a fallback.
const frontendDir = require("fs").existsSync(path.join(__dirname, "dist"))
  ? path.join(__dirname, "dist")
  : path.join(__dirname, "public");
app.use(express.static(frontendDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/unsubscribe/")) return next();
  res.sendFile(path.join(frontendDir, "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Unexpected server error." });
});

async function bootstrapAdmin() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!emailRegex.test(email) || password.length < 8) {
    throw new Error("Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 8 characters in .env.");
  }
  const existing = await User.findOne({ email });
  if (!existing) {
    const passwordHash = await bcrypt.hash(password, 12);
    await User.create({ email, passwordHash });
    console.log(`Initial admin created: ${email}`);
  } else {
    console.log(`Admin account ready: ${email}`);
  }
}


async function start() {
  for (const key of [
    "MONGODB_URI",
    "SESSION_SECRET"
  ]) {
    if (!process.env[key]) {
      throw new Error(`Missing required .env setting: ${key}`);
    }
  }

  if (process.env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters.");
  }

  console.log("Checking MongoDB connection...");

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connection successful.");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    throw error;
  }

  await bootstrapAdmin();

  // Brevo uses HTTPS, avoiding outbound SMTP port restrictions on Render Free.
  if (!brevoApiKey) {
    console.warn("BREVO_API_KEY is missing; campaign sending will fail until it is configured.");
  }
  if (!configuredFromEmail || !emailRegex.test(configuredFromEmail)) {
    console.warn("BREVO_SENDER_EMAIL (or EMAIL_FROM) is missing/invalid; campaign sends will be rejected.");
  }
  if (!process.env.BREVO_WEBHOOK_SECRET || process.env.BREVO_WEBHOOK_SECRET.length < 32) {
    console.warn("BREVO_WEBHOOK_SECRET is missing or shorter than 32 characters; Brevo webhook requests will be rejected or inadequately protected.");
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Email Marketing API running on port ${PORT}`);
  });
}


start().catch(err => {
  console.error("Startup failed:", err.message);
  process.exit(1);
});
