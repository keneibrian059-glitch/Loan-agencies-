require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 3000;
const FEE = 50;
const DATA_DIR = path.join(__dirname, "data");
const STORE = path.join(DATA_DIR, "applications.json");

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(STORE)) {
  fs.writeFileSync(STORE, "[]", { mode: 0o600, flag: "wx" });
}
try {
  fs.chmodSync(DATA_DIR, 0o700);
  fs.chmodSync(STORE, 0o600);
} catch {}

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

const session = require("express-session");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error("ADMIN_PASSWORD and SESSION_SECRET must be set in .env");
  process.exit(1);
}

app.use(session({
  name: "timiza_admin",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 60 * 1000
  }
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) return next();
  return res.redirect("/admin/login");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[ch]);
}


app.use("/api", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

app.use(express.static(path.join(__dirname, "public"), {
  index: "index.html",
  dotfiles: "deny"
}));

function text(value, max = 300) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, max)
    : "";
}

function saveRecord(record) {
  const records = JSON.parse(fs.readFileSync(STORE, "utf8"));
  if (!Array.isArray(records)) throw new Error("Invalid application store");

  records.push(record);
  const temp = STORE + "." + crypto.randomUUID() + ".tmp";

  fs.writeFileSync(temp, JSON.stringify(records, null, 2), {
    mode: 0o600,
    flag: "wx"
  });
  fs.renameSync(temp, STORE);

  try { fs.chmodSync(STORE, 0o600); } catch {}
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    application: "TIMIZA LOAN",
    applicationFeeKes: FEE,
    paymentsEnabled: false
  });
});

app.post("/api/applications", (req, res) => {
  try {
    const fullName = text(req.body.fullName, 100);
    const rawPhone = text(req.body.phone, 24).replace(/[\s()+-]/g, "");
    const email = text(req.body.email, 160).toLowerCase();
    const purpose = text(req.body.purpose, 300);
    const amount = Number(req.body.amount);
    const income = Number(req.body.monthlyIncome);
    const consent = req.body.consent === true || req.body.consent === "true";
    const phone = rawPhone.replace(/^\+/, "");
    const validPhone = /^(?:254[71]\d{8}|0[71]\d{8})$/.test(phone);
    const normalizedPhone = phone.startsWith("0")
      ? "254" + phone.slice(1)
      : phone;
    const allowedAmounts = [1000, 2000, 5000, 10000, 20000];

    if (fullName.length < 2)
      return res.status(400).json({ error: "Enter your full name." });

    if (!validPhone)
      return res.status(400).json({ error: "Enter a valid Kenyan mobile number." });

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Enter a valid email address." });

    if (!allowedAmounts.includes(amount))
      return res.status(400).json({ error: "Choose an available loan amount." });

    if (!Number.isFinite(income) || income < 0 || income > 100000000)
      return res.status(400).json({ error: "Enter a valid monthly income." });

    if (purpose.length < 5)
      return res.status(400).json({ error: "Explain the purpose of the loan." });

    if (!consent)
      return res.status(400).json({ error: "Please confirm the application notice." });

    const now = new Date().toISOString();
    const reference = "TL-" + crypto.randomBytes(5).toString("hex").toUpperCase();

    saveRecord({
      reference,
      fullName,
      phone: normalizedPhone,
      email: email || null,
      requestedAmountKes: amount,
      declaredMonthlyIncomeKes: income,
      purpose,
      applicationFeeKes: FEE,
      applicationStatus: "received_pending_review",
      paymentStatus: "not_requested",
      loanDecision: "not_decided",
      receivedAt: now
    });

    res.status(201).json({
      ok: true,
      reference,
      message: "Your application was received for review. No fee was charged and no loan approval is implied."
    });
  } catch (error) {
    console.error("Could not save application:", error.message);
    res.status(500).json({ error: "Could not save the application. Please try again later." });
  }
});

// Deliberately unavailable: never simulate or falsely confirm payment.
app.post("/api/stk-push", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (process.env.PAYMENTS_ENABLED !== "true") {
    return res.status(503).json({
      error: "Payment collection is disabled."
    });
  }

  const required = [
    "DARAJA_CONSUMER_KEY",
    "DARAJA_CONSUMER_SECRET",
    "DARAJA_BUSINESS_SHORTCODE",
    "DARAJA_TILL_NUMBER",
    "DARAJA_PASSKEY",
    "DARAJA_CALLBACK_URL"
  ];

  if (required.some(k => !process.env[k]?.trim())) {
    return res.status(503).json({
      error: "Daraja production configuration is incomplete."
    });
  }

  if (process.env.DARAJA_ENV !== "production") {
    return res.status(503).json({
      error: "Production credentials must be selected."
    });
  }

  const reference = text(req.body.reference, 80);
  const phone = text(req.body.phone, 20).replace(/[\s()+-]/g, "");
  const normalizedPhone = phone.startsWith("0")
    ? "254" + phone.slice(1)
    : phone;

  if (!/^TL-[A-F0-9]{10}$/i.test(reference)) {
    return res.status(400).json({ error: "Invalid application reference." });
  }

  if (!/^254[71]\d{8}$/.test(normalizedPhone)) {
    return res.status(400).json({ error: "Enter a valid Kenyan M-Pesa number." });
  }

  let records;
  try {
    records = JSON.parse(fs.readFileSync(STORE, "utf8"));
    if (!Array.isArray(records)) throw new Error("Invalid store");
  } catch {
    return res.status(500).json({ error: "Application records unavailable." });
  }

  const matches = records.filter(r => r.reference === reference);
  if (matches.length !== 1) {
    return res.status(404).json({ error: "Application not found." });
  }

  const record = matches[0];

  if (record.phone !== normalizedPhone) {
    return res.status(400).json({
      error: "Phone number must match the application."
    });
  }

  if (record.paymentStatus === "paid") {
    return res.status(409).json({ error: "This application fee is already paid." });
  }

  if (record.paymentStatus === "pending") {
    return res.status(409).json({
      error: "A payment request is already pending. Do not retry yet."
    });
  }

  // Never send an STK request until a durable pending state is saved.
  record.paymentStatus = "pending";
  record.paymentAmountKes = 50;
  record.paymentPhone = normalizedPhone;
  record.paymentRequestedAt = new Date().toISOString();

  const temp = STORE + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(records, null, 2), {
      mode: 0o600,
      flag: "wx"
    });
    fs.renameSync(temp, STORE);
    try { fs.chmodSync(STORE, 0o600); } catch {}
  } catch (e) {
    try { fs.unlinkSync(temp); } catch {}
    console.error("Could not save pending payment.");
    return res.status(500).json({ error: "Could not start payment safely." });
  }

  try {
    const base = "https://api.safaricom.co.ke";
    const credentials = Buffer.from(
      process.env.DARAJA_CONSUMER_KEY + ":" +
      process.env.DARAJA_CONSUMER_SECRET
    ).toString("base64");

    const tokenResponse = await fetch(
      base + "/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: "Basic " + credentials } }
    );

    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error("Production OAuth failed");
    }

    const timestamp = new Date().toISOString()
      .replace(/[-:TZ.]/g, "").slice(0, 14);

    const shortcode = process.env.DARAJA_BUSINESS_SHORTCODE.trim();
    const password = Buffer.from(
      shortcode + process.env.DARAJA_PASSKEY.trim() + timestamp
    ).toString("base64");

    const stkResponse = await fetch(
      base + "/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokenData.access_token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerBuyGoodsOnline",
          Amount: 50,
          PartyA: normalizedPhone,
          PartyB: process.env.DARAJA_TILL_NUMBER.trim(),
          PhoneNumber: normalizedPhone,
          CallBackURL: process.env.DARAJA_CALLBACK_URL.trim(),
          AccountReference: reference,
          TransactionDesc: "Loan application processing fee"
        })
      }
    );

    const data = await stkResponse.json().catch(() => ({}));

    if (!stkResponse.ok || data.ResponseCode !== "0" ||
        !data.CheckoutRequestID || !data.MerchantRequestID) {
      // Do not automatically retry: Safaricom may have accepted a request
      // even if the response was interrupted.
      console.error("Daraja STK request was not confirmed; reconcile before retrying.");
      return res.status(502).json({
        error: "Safaricom did not confirm the request. Check transaction status before retrying."
      });
    }

    // Store the Safaricom IDs so a verified callback can match this request.
    record.checkoutRequestID = data.CheckoutRequestID;
    record.merchantRequestID = data.MerchantRequestID;
    record.stkResponseAt = new Date().toISOString();

    const latest = JSON.parse(fs.readFileSync(STORE, "utf8"));
    const current = latest.find(r => r.reference === reference);
    if (!current || current.paymentStatus !== "pending") {
      return res.status(409).json({
        error: "Payment state changed. Reconcile this request before retrying."
      });
    }

    current.checkoutRequestID = data.CheckoutRequestID;
    current.merchantRequestID = data.MerchantRequestID;
    current.stkResponseAt = new Date().toISOString();

    const temp2 = STORE + "." + crypto.randomUUID() + ".tmp";
    fs.writeFileSync(temp2, JSON.stringify(latest, null, 2), {
      mode: 0o600,
      flag: "wx"
    });
    fs.renameSync(temp2, STORE);
    try { fs.chmodSync(STORE, 0o600); } catch {}

    return res.status(202).json({
      ok: true,
      message: "Safaricom accepted the STK request. Check the phone for a prompt.",
      reference
    });
  } catch (error) {
    console.error("STK request failed:", error.message);
    return res.status(502).json({
      error: "Could not confirm the STK request. Reconcile before retrying."
    });
  }
});

// Safeguard: callback acknowledgement only; this does NOT verify or record payments.
app.post("/api/mpesa/callback", (req, res) => {
  res.set("Cache-Control", "no-store");
  console.log("M-Pesa callback received; payment verification is not enabled.");
  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Callback received for processing"
  });
});

app.get("/admin/login", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.session.isAdmin === true) return res.redirect("/admin");
  res.type("html").send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TIMIZA LOAN Admin Login</title>
<body style="font:16px Arial;max-width:420px;margin:12vh auto;padding:24px;background:#f7f8f4">
<h1>TIMIZA LOAN</h1><h2>Administrator login</h2>
<form method="post" action="/admin/login">
<label>Password<br><input type="password" name="password" required autocomplete="current-password" style="box-sizing:border-box;width:100%;padding:12px;margin:12px 0"></label>
<button style="padding:12px 18px">Sign in</button>
</form></body></html>`);
});

app.post("/admin/login", rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5,
  standardHeaders: "draft-7", legacyHeaders: false
}), (req, res, next) => {
  const supplied = typeof req.body.password === "string" ? req.body.password : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_PASSWORD);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) {
    return res.status(401).type("html").send(
      '<p>Login failed.</p><p><a href="/admin/login">Try again</a></p>'
    );
  }

  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.isAdmin = true;
    res.redirect("/admin");
  });
});

app.post("/admin/application-status", requireAdmin, (req, res) => {
  const suppliedToken = typeof req.body.csrfToken === "string" ? req.body.csrfToken : "";
  const expectedToken = typeof req.session.adminCsrfToken === "string"
    ? req.session.adminCsrfToken : "";

  const a = Buffer.from(suppliedToken);
  const b = Buffer.from(expectedToken);
  const tokenValid = a.length > 0 && a.length === b.length &&
    crypto.timingSafeEqual(a, b);

  if (!tokenValid) {
    return res.status(403).type("text").send(
      "Request expired or invalid. Reload the admin page and try again."
    );
  }

  const reference = typeof req.body.reference === "string"
    ? req.body.reference.trim() : "";
  const applicationStatus = req.body.applicationStatus;
  const loanDecision = req.body.loanDecision;

  const allowedAppStatuses = [
    "received_pending_review", "under_review", "review_completed"
  ];
  const allowedDecisions = ["not_decided", "approved", "rejected"];

  if (!reference || reference.length > 80 ||
      !allowedAppStatuses.includes(applicationStatus) ||
      !allowedDecisions.includes(loanDecision)) {
    return res.status(400).type("text").send("Invalid application status or decision.");
  }

  try {
    const records = JSON.parse(fs.readFileSync(STORE, "utf8"));
    if (!Array.isArray(records)) throw new Error("Invalid application store");

    const matches = records.filter(r => r.reference === reference);
    if (matches.length !== 1) {
      return res.status(404).type("text").send("Application not found or reference is not unique.");
    }

    const record = matches[0];
    record.applicationStatus = applicationStatus;
    record.loanDecision = loanDecision;
    record.statusUpdatedAt = new Date().toISOString();

    const temp = STORE + "." + crypto.randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, JSON.stringify(records, null, 2), {
        mode: 0o600,
        flag: "wx"
      });
      fs.renameSync(temp, STORE);
      try { fs.chmodSync(STORE, 0o600); } catch {}
    } catch (err) {
      try { fs.unlinkSync(temp); } catch {}
      throw err;
    }

    return res.redirect(303, "/admin");
  } catch (error) {
    console.error("Could not update application status:", error.message);
    return res.status(500).type("text").send("Could not save the status change.");
  }
});

app.get("/admin", requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  let records;
  try {
    records = JSON.parse(fs.readFileSync(STORE, "utf8"));
    if (!Array.isArray(records)) throw new Error("Invalid store");
  } catch {
    return res.status(500).send("Application records could not be read.");
  }

  req.session.adminCsrfToken ||= crypto.randomBytes(32).toString("hex");
  const csrfToken = req.session.adminCsrfToken;

  const rows = records.slice().reverse().map(r => {
    const appStatus = String(r.applicationStatus || "received_pending_review");
    const decision = String(r.loanDecision || "not_decided");
    const appOptions = [
      ["received_pending_review", "Pending review"],
      ["under_review", "Under review"],
      ["review_completed", "Review completed"]
    ].map(([v, label]) =>
      `<option value="${v}"${appStatus === v ? " selected" : ""}>${label}</option>`
    ).join("");
    const decisionOptions = [
      ["not_decided", "Not decided"],
      ["approved", "Approved"],
      ["rejected", "Rejected"]
    ].map(([v, label]) =>
      `<option value="${v}"${decision === v ? " selected" : ""}>${label}</option>`
    ).join("");

    return `<tr>
      <td>${escapeHtml(r.reference)}</td>
      <td>${escapeHtml(r.fullName)}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>KSh ${escapeHtml(r.requestedAmountKes)}</td>
      <td>${escapeHtml(appStatus)}</td>
      <td>${escapeHtml(decision)}</td>
      <td>${escapeHtml(r.receivedAt)}</td>
      <td><form method="post" action="/admin/application-status"
        onsubmit="return confirm('Save the status changes for this application?')">
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="reference" value="${escapeHtml(r.reference)}">
        <label>Application status
          <select name="applicationStatus">${appOptions}</select>
        </label><br>
        <label>Loan decision
          <select name="loanDecision">${decisionOptions}</select>
        </label><br>
        <button type="submit">Save changes</button>
      </form></td>
    </tr>`;
  }).join("");

  res.type("html").send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TIMIZA LOAN Admin</title>
<body style="font:14px Arial;margin:24px;background:#f7f8f4;color:#192c26">
<header style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
<h1>TIMIZA LOAN · Applications</h1>
<form method="post" action="/admin/logout"><button>Sign out</button></form>
</header>
<p>Records: ${records.length} · Application fee setting: KSh 50 · Payment collection is disabled.</p>
<div style="overflow:auto;background:white;padding:12px;border-radius:8px">
<table style="border-collapse:collapse;width:100%;text-align:left">
<thead><tr>${["Reference","Applicant","Phone","Requested amount","Application status","Loan decision","Received","Admin controls"].map(x=>`<th style="padding:10px;border-bottom:1px solid #ddd">${x}</th>`).join("")}</tr></thead>
<tbody>${rows || '<tr><td colspan="8" style="padding:12px">No applications yet.</td></tr>'}</tbody>
</table></div></body></html>`);
});

app.post("/admin/logout", requireAdmin, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie("timiza_admin", {
      httpOnly: true, sameSite: "strict",
      secure: process.env.NODE_ENV === "production"
    });
    res.redirect("/admin/login");
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("TIMIZA LOAN server started on port " + PORT);
  console.log("Application fee: KSh " + FEE);
  console.log("M-Pesa collection: DISABLED");
});
