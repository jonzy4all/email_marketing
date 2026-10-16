require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 6000);
const DELAY_MS = Math.max(10000, Number(process.env.EMAIL_DELAY_MS || 10000));
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
  status: { type: String, enum: ["pending", "sending", "sent", "failed", "skipped"], default: "pending" },
  error: { type: String, default: "" },
  sentAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  unsubscribeToken: { type: String, default: "" }
}, { _id: true });

const campaignSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  from: { type: String, required: true },
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

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

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
  res.json({ sender: normalizeEmail(process.env.SMTP_FROM) });
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
    const sent = c.recipients.filter(r => r.status === "sent").length;
    const failed = c.recipients.filter(r => r.status === "failed").length;
    const skipped = c.recipients.filter(r => r.status === "skipped").length;
    return {
      id: c._id,
      subject: c.subject,
      status: c.status,
      total: c.recipients.length,
      sent, failed, skipped,
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
  const subject = String(req.body.subject || "").trim();
  const message = String(req.body.message || "").trim();
  let recipients = Array.isArray(req.body.recipients) ? req.body.recipients.map(normalizeEmail) : [];

  if (!emailRegex.test(from) || from !== normalizeEmail(process.env.SMTP_FROM)) {
    return res.status(400).json({ error: "From must match the configured SMTP_FROM address." });
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
    owner: req.session.userId, from, subject, message, recipients: recipientDocs, status: "queued"
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
        await transporter.sendMail({
          from: campaign.from,
          to: recipient.email,
          subject: campaign.subject,
          text: `${campaign.message}`,
          headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
        });
        recipient.status = "sent";
        recipient.sentAt = new Date();
        recipient.error = "";
      } catch (err) {
        recipient.status = "failed";
        recipient.error = safeError(err);
      }
      await campaign.save();

      // Ten seconds after each attempt before moving to the next recipient.
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
  const sent = c.recipients.filter(r => r.status === "sent").length;
  const failed = c.recipients.filter(r => r.status === "failed").length;
  const skipped = c.recipients.filter(r => r.status === "skipped").length;
  res.json({
    id: c._id, status: c.status, total: c.recipients.length, sent, failed, skipped,
    pending: c.recipients.filter(r => ["pending", "sending"].includes(r.status)).length,
    recipients: c.recipients.map(r => ({ email: r.email, status: r.status, error: r.error, attempts: r.attempts }))
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

  // SMTP availability should not prevent administrators from signing in or viewing history.
  // Campaign sends will report their own errors if SMTP is not configured/reachable.
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM) {
    console.log("Checking SMTP connection...");
    try {
      await transporter.verify();
      console.log("SMTP connection successful.");
    } catch (error) {
      console.error("SMTP connection failed (sign-in remains available):", error.message);
    }
  } else {
    console.warn("SMTP is not fully configured; sign-in is available, but sending campaigns requires SMTP settings.");
  }

  app.listen(PORT, () => {
    console.log(`Email Marketing API running at http://localhost:${PORT}`);
  });
}


start().catch(err => {
  console.error("Startup failed:", err.message);
  process.exit(1);
});
