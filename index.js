require("dotenv").config();

const express = require("express");
const axios   = require("axios");
const moment  = require("moment");
const TelegramBot = require("node-telegram-bot-api");

// ─── APP SETUP ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─── HEALTH CHECK (keep-alive target + uptime monitors) ──────────────────────
app.get("/", (req, res) => res.status(200).send("OK"));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TILL_NUMBER     = "4902476";
const TILL_NAME       = "ALJAKI Enterprise";
const ADMIN_IDS       = ["6954749470", "5355760284"];
const SHORTCODE       = process.env.SHORTCODE;
const PASSKEY         = process.env.PASSKEY;
const CONSUMER_KEY    = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const CALLBACK_URL    = process.env.CALLBACK_URL || "";
const BOT_TOKEN       = process.env.BOT_TOKEN;
const RENDER_URL      = process.env.RENDER_EXTERNAL_URL
  || (CALLBACK_URL ? CALLBACK_URL.replace("/mpesa/callback", "") : null);

// ─── CHANNEL_ID as NUMBER (string causes silent failures) ────────────────────
const CHANNEL_ID = -1001567081082;

// ─── BOT: WEBHOOK MODE ───────────────────────────────────────────────────────
// Webhook = Telegram pushes updates to our server. Much more reliable on Render
// than polling, and eliminates the 409 Conflict error on redeploy entirely.
const bot = new TelegramBot(BOT_TOKEN, { webHook: { port: process.env.PORT || 3000 } });

if (RENDER_URL) {
  const webhookUrl = `${RENDER_URL}/bot${BOT_TOKEN}`;
  bot.setWebHook(webhookUrl)
    .then(() => console.log(`✅ Webhook set: ${webhookUrl}`))
    .catch((err) => console.error("❌ Webhook set failed:", err.message));
} else {
  console.warn("⚠️ RENDER_EXTERNAL_URL not set — webhook not registered.");
}

// ─── EARLY ENV VALIDATION ────────────────────────────────────────────────────
(function validateEnv() {
  const required = {
    BOT_TOKEN:           BOT_TOKEN,
    SHORTCODE:           process.env.SHORTCODE,
    PASSKEY:             process.env.PASSKEY,
    CONSUMER_KEY:        process.env.CONSUMER_KEY,
    CONSUMER_SECRET:     process.env.CONSUMER_SECRET,
    CALLBACK_URL:        process.env.CALLBACK_URL,
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    const msg =
      `🚨 *STARTUP WARNING*\n\n` +
      `Missing environment variables:\n` +
      missing.map((k) => `• \`${k}\``).join("\n") +
      `\n\n⚠️ Bot and/or STK Push will not work until these are set.`;
    console.error("❌ Missing env vars:", missing.join(", "));
    setTimeout(() => {
      ADMIN_IDS.forEach((id) => bot.sendMessage(id, msg, { parse_mode: "Markdown" }).catch(() => {}));
    }, 5000);
  } else {
    console.log("✅ All required environment variables are present.");
  }
})();

// ─── PLAN CONFIG ─────────────────────────────────────────────────────────────
const PLAN_DAYS = {
  "1 Day":    1,
  "1 Week":   7,
  "2 Weeks":  14,
  "1 Month":  30,
  "6 Months": 180,
  "1 Year":   365,
};

const subTimers = {};

// ─── TYPING INDICATOR ────────────────────────────────────────────────────────
async function sendTyping(chatId, durationMs = 1500) {
  try {
    await bot.sendChatAction(chatId, "typing");
    await new Promise((r) => setTimeout(r, durationMs));
  } catch (_) {}
}

// ─── GRANT ACCESS ────────────────────────────────────────────────────────────
async function grantAccess(chatId, planLabel, paymentSummary) {
  console.log(`🔍 grantAccess called: chatId=${chatId}, planLabel="${planLabel}"`);

  const resolvedLabel = PLAN_DAYS[planLabel] !== undefined ? planLabel : "1 Month";
  if (resolvedLabel !== planLabel) {
    console.warn(`⚠️ Unknown planLabel "${planLabel}" — falling back to "1 Month"`);
  }

  const days = PLAN_DAYS[resolvedLabel];
  console.log(`📅 Days resolved: ${days} for plan "${resolvedLabel}"`);

  if (!days || isNaN(days)) {
    console.error(`❌ grantAccess: could not resolve days for plan "${planLabel}"`);
    notifyAdmins(
      `⚠️ *grantAccess FAILED*\n\nChatID: \`${chatId}\`\nBad planLabel: \`${planLabel}\`\n\nManual fix:\n\`/grant ${chatId}\``
    );
    return;
  }

  try {
    const expireDate = Math.floor(Date.now() / 1000) + days * 86400;
    console.log(`🔗 Creating invite link: chatId=${chatId}, days=${days}, expireDate=${expireDate}, CHANNEL_ID=${CHANNEL_ID}`);

    const inviteRes = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date:  expireDate,
      name:         `Access-${chatId}-${Date.now()}`
    });

    const inviteLink = inviteRes.invite_link;
    console.log(`✅ Invite link created: ${inviteLink}`);

    await bot.sendMessage(chatId,
      `🎉 *Access Granted!*\n\n` +
      `${paymentSummary}\n\n` +
      `👇 Tap the link below to join:\n${inviteLink}\n\n` +
      `⚠️ *Important:*\n` +
      `• This link is *single-use* — it works for you only\n` +
      `• Once you join the channel, the link expires automatically\n` +
      `• Your access expires in *${days} day(s)*\n\n` +
      `_Welcome to the family!_ 🔐`,
      { parse_mode: "Markdown", disable_web_page_preview: false }
    );

    clearSubTimers(chatId);
    const timers     = {};
    timers.expiresAt = Date.now() + days * 86400 * 1000;

    if (days > 1) {
      timers.warnTimer = setTimeout(() => {
        bot.sendMessage(chatId,
          `⏰ *Heads up!*\n\nYour *${resolvedLabel}* access expires in *24 hours*.\n\nRenew now to stay connected 😊`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔄 Renew My Access", callback_data: "change_package" }]] }
          }
        ).catch(() => {});
      }, (days - 1) * 86400 * 1000);
    }

    timers.kickTimer = setTimeout(async () => {
      try {
        await bot.banChatMember(CHANNEL_ID, chatId);
        await bot.unbanChatMember(CHANNEL_ID, chatId);
        console.log(`🚪 User ${chatId} removed after plan expiry`);
      } catch (e) {
        console.error("Kick error:", e.message);
      }
      bot.sendMessage(chatId,
        `👋 *Your access has ended.*\n\nYour *${resolvedLabel}* plan has expired. We hope you enjoyed your time with us! 🙏\n\nWhenever you're ready to come back, we'll be here 😊`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] }
        }
      ).catch(() => {});
      delete subTimers[chatId];
    }, days * 86400 * 1000);

    subTimers[chatId] = timers;
    console.log(`✅ Access fully set up for ${chatId} | ${resolvedLabel} | ${days}d`);

  } catch (err) {
    console.error("❌ grantAccess error:", err.message, err.stack);

    // ── Notify admins with one-tap approve button ─────────────────────────
    notifyAdmins(
      `⚠️ *Auto-invite FAILED for* \`${chatId}\`\n\n` +
      `Plan: *${resolvedLabel}* (${days} days)\n` +
      `Error: \`${err.message}\`\n\n` +
      `Tap below to grant access manually 👇`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: `✅ Grant Access to ${chatId}`, callback_data: `admin_grant_${chatId}_${resolvedLabel}` }
          ]]
        }
      }
    );

    // ── Apologise sincerely to user ───────────────────────────────────────
    bot.sendMessage(chatId,
      `😔 *We're so sorry for the delay!*\n\n` +
      `Your payment was received successfully ✅ — but we ran into a small technical issue sending your access link automatically.\n\n` +
      `*Please don't worry — you will not lose your access.* Our team has been notified and will send your link manually within a few minutes. 🙏\n\n` +
      `We sincerely apologise for the inconvenience. Thank you so much for your patience! 💛`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  }
}

function clearSubTimers(chatId) {
  if (subTimers[chatId]) {
    clearTimeout(subTimers[chatId].warnTimer);
    clearTimeout(subTimers[chatId].kickTimer);
    delete subTimers[chatId];
  }
}

// ─── USDT CONFIG ─────────────────────────────────────────────────────────────
const USDT_WALLET  = "TQQ7Y4PKNs2rMuN2AzHGc2k43MuyMvrjy9";
const TRONGRID_KEY = "c2959dcd-5b2f-4742-939b-a61077a0f520";
const pendingUSDT  = {};

// ─── PLANS ───────────────────────────────────────────────────────────────────
const PLANS = {
  naughty_1day:    { label: "1 Day",    price: 40 },
  naughty_1week:   { label: "1 Week",   price: 170 },
  naughty_2weeks:  { label: "2 Weeks",  price: 270 },
  naughty_1month:  { label: "1 Month",  price: 450 },
  naughty_6months: { label: "6 Months", price: 2500 },
  naughty_1year:   { label: "1 Year",   price: 6200 },
  premium_1day:    { label: "1 Day",    price: 50 },
  premium_1week:   { label: "1 Week",   price: 220 },
  premium_2weeks:  { label: "2 Weeks",  price: 400 },
  premium_1month:  { label: "1 Month",  price: 680 },
  premium_6months: { label: "6 Months", price: 3500 },
  premium_1year:   { label: "1 Year",   price: 7000 },
};

const USDT_PLANS = [
  { key: "usdt_1day",    label: "1 Day",    usdt: 5 },
  { key: "usdt_1week",   label: "1 Week",   usdt: 19 },
  { key: "usdt_1month",  label: "1 Month",  usdt: 35 },
  { key: "usdt_6months", label: "6 Months", usdt: 90 },
  { key: "usdt_1year",   label: "1 Year",   usdt: 250 },
];

// ─── STORE ───────────────────────────────────────────────────────────────────
const userSelections  = {};
const pendingSTK      = {};
const reminderTimers  = {};
// awaitingReceipt[chatId] = { plan, pkg, price } when bot expects M-Pesa code
const awaitingReceipt = {};

// ─── PAYMENT LEDGER ──────────────────────────────────────────────────────────
const paymentLedger = [];

function recordPayment({ chatId, username, pkg, plan, amount, ref, phone, currency = "KES" }) {
  paymentLedger.push({
    chatId,
    username: username || String(chatId),
    package:  pkg,
    plan,
    amount:   Number(amount),
    currency,
    ref,
    phone,
    paidAt:   moment().format("DD MMM YYYY, HH:mm")
  });
}

function getLedgerStats() {
  const kesOnly  = (arr) => arr.filter((p) => p.currency !== "USDT");
  const usdtOnly = (arr) => arr.filter((p) => p.currency === "USDT");
  const sum      = (arr) => arr.reduce((s, p) => s + p.amount, 0);
  const today    = moment().startOf("day");
  const week     = moment().startOf("isoWeek");
  const todayAll = paymentLedger.filter((p) => moment(p.paidAt, "DD MMM YYYY, HH:mm").isSameOrAfter(today));
  const weekAll  = paymentLedger.filter((p) => moment(p.paidAt, "DD MMM YYYY, HH:mm").isSameOrAfter(week));
  return {
    totalKes:   sum(kesOnly(paymentLedger)),
    todayKes:   sum(kesOnly(todayAll)),
    weekKes:    sum(kesOnly(weekAll)),
    totalUsdt:  sum(usdtOnly(paymentLedger)),
    todayUsdt:  sum(usdtOnly(todayAll)),
    weekUsdt:   sum(usdtOnly(weekAll)),
    todayCount: todayAll.length,
    weekCount:  weekAll.length,
    allCount:   paymentLedger.length,
  };
}

// ─── NOTIFY ADMINS ───────────────────────────────────────────────────────────
function notifyAdmins(message, opts = {}) {
  ADMIN_IDS.forEach((id) => {
    bot.sendMessage(id, message, { parse_mode: "Markdown", ...opts })
      .catch((err) => console.error(`❌ Admin notify failed [${id}]: ${err.message}`));
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function tillCard(packageName, plan, price) {
  return (
    `╔══════════════════════════╗\n` +
    `║   💳  PAYMENT DETAILS    ║\n` +
    `╠══════════════════════════╣\n` +
    `║  📦 ${(packageName || "").substring(0, 22).padEnd(22)}║\n` +
    `║  ⏱  Plan: ${(plan || "").padEnd(18)}║\n` +
    `║  💰 Amount: Ksh ${String(price || 0).padEnd(11)}║\n` +
    `╠══════════════════════════╣\n` +
    `║  📲 M-Pesa Till Number   ║\n` +
    `║                          ║\n` +
    `║     🏦  ${TILL_NUMBER.padEnd(18)}║\n` +
    `║  ${TILL_NAME.substring(0, 26).padEnd(26)}║\n` +
    `╚══════════════════════════╝`
  );
}

function clearReminders(chatId) {
  if (reminderTimers[chatId]) {
    reminderTimers[chatId].timers.forEach(clearTimeout);
    delete reminderTimers[chatId];
  }
}

// ─── SMART REMINDERS ─────────────────────────────────────────────────────────
function scheduleReminders(chatId) {
  clearReminders(chatId);
  const sel   = userSelections[chatId] || {};
  const pkg   = sel.package || "the package";
  const price = sel.price || "";

  const messages = [
    {
      delay: 10 * 60 * 1000,
      text: `👋 Hey, just checking in — did you run into any trouble during checkout?\n\nSometimes M-Pesa gets a little moody. Your *${pkg}* spot is still open. 😊`,
      keyboard: [
        [{ text: "✅ Complete My Purchase", callback_data: "pay_stk" }],
        [{ text: "⚠️ I Had an Issue",       callback_data: "need_help" }],
        [{ text: "🚫 Not Interested",        callback_data: "dismiss_reminder" }]
      ]
    },
    {
      delay: 30 * 60 * 1000,
      text: `🔍 Your selected plan${price ? ` (*Ksh ${price}*)` : ""} is waiting whenever you're ready. ⏳`,
      keyboard: [
        [{ text: "💳 I'm Ready to Pay",  callback_data: "pay_stk" }],
        [{ text: "🔄 See Packages",      callback_data: "change_package" }],
        [{ text: "🚫 Dismiss",            callback_data: "dismiss_reminder" }]
      ]
    },
    {
      delay: 2 * 60 * 60 * 1000,
      text: `💡 A lot of people who hesitated said it was *100% worth it* after joining.\n\nIf anything is holding you back, just say the word. 🤝`,
      keyboard: [
        [{ text: "💬 I Have a Question", callback_data: "need_help" }],
        [{ text: "✅ Let's Do This",      callback_data: "pay_stk" }],
        [{ text: "🚫 No Thanks",          callback_data: "dismiss_reminder" }]
      ]
    }
  ];

  const timers = messages.map(({ delay, text, keyboard }) =>
    setTimeout(() => {
      const current = userSelections[chatId];
      if (current && current.paidAt) return;
      bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
      }).catch(() => {});
    }, delay)
  );
  reminderTimers[chatId] = { timers };
}

// ─── M-PESA: GET ACCESS TOKEN ─────────────────────────────────────────────────
async function getMpesaToken() {
  try {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
    const res  = await axios.get(
      "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: `Basic ${auth}` } }
    );
    return res.data.access_token;
  } catch (err) {
    notifyAdmins(`🚨 *Daraja Token Error*\n\`${err.response?.data?.errorMessage || err.message}\``);
    throw err;
  }
}

// ─── M-PESA: STK PUSH ────────────────────────────────────────────────────────
async function stkPush(phone, amount, chatId) {
  try {
    const token     = await getMpesaToken();
    const timestamp = moment().format("YYYYMMDDHHmmss");
    const password  = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString("base64");

    let normalized = phone.trim().replace(/^\+/, "").replace(/^0/, "254");

    if (!/^2547\d{8}$|^2541\d{8}$/.test(normalized)) {
      throw new Error(`Invalid phone format: ${normalized}`);
    }

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   "CustomerBuyGoodsOnline",
      Amount:            Math.ceil(Number(amount)),
      PartyA:            normalized,
      PartyB:            TILL_NUMBER,
      PhoneNumber:       normalized,
      CallBackURL:       CALLBACK_URL,
      AccountReference:  "ALJAKI",
      TransactionDesc:   "Content Access"
    };

    const res = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      payload,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    if (res.data.ResponseCode === "0") {
      const sel   = userSelections[chatId] || {};
      const entry = {
        chatId,
        plan:     sel.plan    || null,
        pkg:      sel.package || null,
        price:    sel.price   || amount,
        username: sel.username || String(chatId),
      };
      pendingSTK[res.data.CheckoutRequestID] = entry;
      console.log(`📌 Registered pending STK: ${res.data.CheckoutRequestID} →`, JSON.stringify(entry));
    } else {
      console.warn(`⚠️ STK push non-zero ResponseCode: ${res.data.ResponseCode} — ${res.data.ResponseDescription}`);
    }
    return res.data;
  } catch (err) {
    notifyAdmins(
      `🚨 *STK Push Failed*\nChat ID: \`${chatId}\`\n` +
      `Error: \`${JSON.stringify(err.response?.data || err.message)}\``
    );
    throw err;
  }
}

// ─── M-PESA CALLBACK ─────────────────────────────────────────────────────────
app.post("/mpesa/callback", (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  console.log("📩 M-PESA CALLBACK RECEIVED:", JSON.stringify(req.body, null, 2));

  try {
    const body    = req.body?.Body?.stkCallback;
    const checkId = body?.CheckoutRequestID;
    const code    = body?.ResultCode;

    console.log(`🔍 Callback: CheckoutRequestID=${checkId}, ResultCode=${code}`);

    const pending = pendingSTK[checkId];

    if (!pending) {
      console.warn(`⚠️ Unknown CheckoutRequestID: ${checkId}`);
      notifyAdmins(
        `⚠️ *Unknown STK Callback*\n\n` +
        `CheckoutRequestID: \`${checkId}\`\nResultCode: ${code}\n\n` +
        `_Server may have restarted after STK push._\n\nIf a user paid:\n\`/grant <chatId>\``
      );
      return;
    }

    delete pendingSTK[checkId];
    const { chatId, plan, pkg, price, username } = pending;
    console.log(`✅ Matched pending STK: chatId=${chatId}, plan=${plan}, pkg=${pkg}`);

    if (code === 0) {
      const meta      = body.CallbackMetadata?.Item || [];
      const get       = (name) => meta.find((i) => i.Name === name)?.Value ?? "—";
      const amount    = get("Amount");
      const mpesaCode = get("MpesaReceiptNumber");
      const phone     = get("PhoneNumber");

      console.log(`💰 Payment confirmed: amount=${amount}, ref=${mpesaCode}, phone=${phone}`);

      const sel  = userSelections[chatId] || {};
      sel.paidAt = new Date().toISOString();
      sel.stkRef = mpesaCode;
      sel.phone  = phone;
      if (!sel.plan    && plan) sel.plan    = plan;
      if (!sel.package && pkg)  sel.package = pkg;
      userSelections[chatId] = sel;
      clearReminders(chatId);

      const finalPlan = sel.plan || plan || "1 Month";
      console.log(`🎯 Final plan for grantAccess: "${finalPlan}"`);

      recordPayment({
        chatId,
        username: sel.username || username,
        pkg:      sel.package  || pkg  || "N/A",
        plan:     finalPlan,
        amount,
        ref:      mpesaCode,
        phone
      });

      grantAccess(
        chatId,
        finalPlan,
        `✅ Ksh *${amount}* received via M-Pesa\n🧾 Ref: \`${mpesaCode}\``
      );

      notifyAdmins(
        `💰 *PAYMENT CONFIRMED (STK)*\n\n` +
        `👤 \`${chatId}\`\n📦 ${sel.package || pkg || "N/A"} — ${finalPlan}\n` +
        `💰 Ksh ${amount} | 🧾 \`${mpesaCode}\`\n📱 ${phone}\n\n➡️ Access sent automatically.`
      );

    } else {
      console.log(`❌ STK failed for ${chatId} | ResultCode: ${code} | Desc: ${body?.ResultDesc}`);

      // ── Ask user for M-Pesa receipt code as fallback ──────────────────────
      awaitingReceipt[chatId] = {
        plan:  plan || (userSelections[chatId] || {}).plan || "1 Month",
        pkg:   pkg  || (userSelections[chatId] || {}).package || "N/A",
        price: price || (userSelections[chatId] || {}).price || 0,
      };

      bot.sendMessage(chatId,
        `⚠️ *Payment prompt was not completed.*\n\n` +
        `This can happen if:\n• The prompt timed out\n• Wrong PIN was entered\n• Network was unstable\n\n` +
        `📋 *If your M-Pesa was actually deducted*, please type your *M-Pesa confirmation code* from your SMS (e.g. \`RCX4B2K9QP\`) and our team will verify and send your access link. 🔍\n\n` +
        `Otherwise, choose an option below 👇`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
              [{ text: "🔄 Try STK Push Again",    callback_data: "pay_stk" }],
              [{ text: "❓ I Need Help",            callback_data: "need_help" }]
            ]
          }
        }
      ).catch(() => {});
    }
  } catch (err) {
    console.error("STK Callback error:", err.message, err.stack);
    notifyAdmins(`🚨 *STK Callback crashed*\n\`${err.message}\``);
  }
});

// ─── USDT: POLL TRONGRID ─────────────────────────────────────────────────────
async function startUsdtPoller(chatId, expectedUsdt) {
  stopUsdtPoller(chatId);
  const expiresAt = Date.now() + 30 * 60 * 1000;
  const startTime = Math.floor(Date.now() / 1000) - 60;

  const intervalId = setInterval(async () => {
    try {
      if (Date.now() > expiresAt) {
        stopUsdtPoller(chatId);
        bot.sendMessage(chatId,
          `⏰ *Payment window expired.*\n\nYour USDT wasn't detected within 30 minutes. Tap below to try again.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Try USDT Again",   callback_data: "pay_usdt" }],
                [{ text: "📲 Switch to M-Pesa", callback_data: "pay_stk" }]
              ]
            }
          }
        ).catch(() => {});
        return;
      }

      const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
      const url =
        `https://api.trongrid.io/v1/accounts/${USDT_WALLET}/transactions/trc20` +
        `?contract_address=${USDT_CONTRACT}&limit=20&min_timestamp=${startTime * 1000}`;

      const res  = await axios.get(url, { headers: { "TRON-PRO-API-KEY": TRONGRID_KEY } });
      const txns = res.data?.data || [];

      for (const tx of txns) {
        const txTo = (tx.to || "").trim().toLowerCase();
        if (txTo !== USDT_WALLET.trim().toLowerCase()) continue;

        const received = parseFloat(tx.value) / 1_000_000;
        if (received >= expectedUsdt) {
          stopUsdtPoller(chatId);
          clearReminders(chatId);

          const sel  = userSelections[chatId] || {};
          sel.paidAt = new Date().toISOString();
          sel.stkRef = tx.transaction_id;
          userSelections[chatId] = sel;

          const finalPlan = sel.plan || "1 Month";

          recordPayment({
            chatId, username: sel.username || String(chatId),
            pkg: sel.package, plan: finalPlan,
            amount: received, ref: tx.transaction_id, phone: "USDT", currency: "USDT"
          });

          grantAccess(chatId, finalPlan,
            `✅ *$${received} USDT* received\n🧾 TxID: \`${tx.transaction_id.substring(0, 20)}...\``
          );

          notifyAdmins(
            `💵 *USDT PAYMENT CONFIRMED*\n\n` +
            `👤 \`${chatId}\`\n📦 ${sel.package || "N/A"} — ${finalPlan}\n` +
            `💰 $${received} USDT\n🧾 \`${tx.transaction_id}\`\n\n➡️ Access sent automatically.`
          );
          return;
        }
      }
    } catch (err) {
      console.error("USDT poller error:", err.message);
    }
  }, 15000);

  pendingUSDT[chatId] = { usdtAmount: expectedUsdt, intervalId, expiresAt };
}

function stopUsdtPoller(chatId) {
  if (pendingUSDT[chatId]) {
    clearInterval(pendingUSDT[chatId].intervalId);
    delete pendingUSDT[chatId];
  }
}

// ─── /start ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId   = msg.chat.id;
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  console.log(`👤 /start — ${username} (${chatId})`);
  await sendTyping(chatId, 1200);
  bot.sendMessage(chatId,
    `Welcome ${username} 🚀\n\nSorry for any delay — I'm here now! Select your preferred package below:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks",          callback_data: "package_naughty_premium_leaks" }],
          [{ text: "💥 Naughty Explicit (Free Hookups)", callback_data: "package_naughty_explicit" }]
        ]
      }
    }
  );
});

bot.onText(/\/myid/, (msg) => {
  bot.sendMessage(msg.chat.id, `🆔 Your Chat ID: \`${msg.chat.id}\``, { parse_mode: "Markdown" });
});

bot.onText(/\/testadmin/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  notifyAdmins(`🧪 *Test Notification*\nTriggered by: \`${msg.chat.id}\``);
  bot.sendMessage(msg.chat.id, "✅ Test sent to all admins.");
});

bot.onText(/\/testlink/, async (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  try {
    const res = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date:  Math.floor(Date.now() / 1000) + 300,
      name:         "TestLink"
    });
    bot.sendMessage(msg.chat.id,
      `✅ *Bot can create invite links!*\n\nTest link: ${res.invite_link}\n\n_Access sending is fully functional._`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    bot.sendMessage(msg.chat.id,
      `❌ *Cannot create invite links*\n\nError: \`${err.message}\`\n\n` +
      `*How to fix:*\n1. Open your Telegram channel\n2. Go to *Administrators*\n` +
      `3. Add the bot as an admin\n4. Enable *"Invite Users via Link"* permission\n5. Run /testlink again`,
      { parse_mode: "Markdown" }
    );
  }
});

bot.onText(/\/buy/, (msg) => {
  const chatId = msg.chat.id;
  const sel    = userSelections[chatId];
  if (!sel || !sel.price) return bot.sendMessage(chatId, "⚠️ Please select a package and plan first using /start.");
  userSelections[chatId].awaitingPhone = true;
  bot.sendMessage(chatId,
    `📱 *Enter your M-Pesa phone number* and we'll send you a payment prompt.\n\nFormat: *07XXXXXXXX* or *01XXXXXXXX*`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/send (\d+) ([\S]+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  const targetChatId = match[1];
  const accessLink   = match[2];
  const sel          = userSelections[targetChatId] || {};
  bot.sendMessage(targetChatId,
    `🎉 *Access Granted!*\n\nYour payment has been verified ✅\n\nHere's your exclusive link 👇\n${accessLink}\n\n_Welcome to the family. Do not share this link._ 🔐`,
    { parse_mode: "Markdown" }
  ).then(() => {
    bot.sendMessage(msg.chat.id, `✅ Access link sent to \`${targetChatId}\``, { parse_mode: "Markdown" });
    if (sel.plan) {
      const days = PLAN_DAYS[sel.plan] || 30;
      clearSubTimers(targetChatId);
      const timers     = {};
      timers.expiresAt = Date.now() + days * 86400 * 1000;
      if (days > 1) {
        timers.warnTimer = setTimeout(() => {
          bot.sendMessage(targetChatId,
            `⏰ *Heads up!*\n\nYour *${sel.plan}* access expires in *24 hours*. Renew now 😊`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Renew", callback_data: "change_package" }]] } }
          ).catch(() => {});
        }, (days - 1) * 86400 * 1000);
      }
      timers.kickTimer = setTimeout(async () => {
        try { await bot.banChatMember(CHANNEL_ID, Number(targetChatId)); await bot.unbanChatMember(CHANNEL_ID, Number(targetChatId)); } catch (e) {}
        bot.sendMessage(targetChatId,
          `👋 *Your access has ended.*\n\nYour *${sel.plan}* plan expired. Hope you enjoyed it! 🙏\n\nCome back anytime 😊`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] } }
        ).catch(() => {});
        delete subTimers[targetChatId];
      }, days * 86400 * 1000);
      subTimers[targetChatId] = timers;
    }
  }).catch((err) => bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`));
});

bot.onText(/\/grant (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  const targetChatId = Number(match[1]);
  const sel          = userSelections[targetChatId] || {};
  const plan         = sel.plan || "1 Month";
  try {
    await grantAccess(targetChatId, plan, `✅ Access manually granted by admin\n📦 Plan: *${plan}*`);
    bot.sendMessage(msg.chat.id, `✅ Access granted to \`${targetChatId}\` for plan *${plan}*`, { parse_mode: "Markdown" });
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Failed to grant access: ${err.message}`);
  }
});

bot.onText(/\/pending/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  const entries = Object.entries(pendingSTK);
  if (!entries.length) return bot.sendMessage(msg.chat.id, "📭 No pending STK transactions.");
  const lines = entries.map(([id, p]) =>
    `• \`${id}\`\n  👤 \`${p.chatId}\` | ${p.pkg || "—"} / ${p.plan || "—"} | Ksh ${p.price || "—"}`
  );
  bot.sendMessage(msg.chat.id,
    `⏳ *Pending STK Pushes (${entries.length})*\n\n${lines.join("\n\n")}\n\n_Use /grant <chatId> if callback was missed._`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/users/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  const entries = Object.entries(userSelections);
  if (!entries.length) return bot.sendMessage(msg.chat.id, "📭 No active user sessions.");
  const lines = entries.map(([id, s]) =>
    `• \`${id}\` — ${s.package || "—"} / ${s.plan || "—"} / Ksh ${s.price || "—"}${s.paidAt ? " ✅ PAID" : ""}`
  );
  bot.sendMessage(msg.chat.id, `👥 *Active Sessions (${entries.length})*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  const targets = Object.keys(userSelections);
  if (!targets.length) return bot.sendMessage(msg.chat.id, "📭 No users to broadcast to.");
  targets.forEach((id) => bot.sendMessage(id, `📢 *Announcement*\n\n${match[1]}`, { parse_mode: "Markdown" }).catch(() => {}));
  bot.sendMessage(msg.chat.id, `📣 Broadcast sent to *${targets.length}* user(s).`, { parse_mode: "Markdown" });
});

bot.onText(/\/stats/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  const all  = Object.values(userSelections);
  const paid = all.filter((s) => s.paidAt).length;
  bot.sendMessage(msg.chat.id,
    `📊 *Bot Stats*\n\n👥 Total Sessions: *${all.length}*\n✅ Paid: *${paid}*\n⏳ Pending: *${all.length - paid}*\n💵 Awaiting USDT: *${Object.keys(pendingUSDT).length}*\n⏳ Pending STK: *${Object.keys(pendingSTK).length}*`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/balance/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  const s      = getLedgerStats();
  const recent = paymentLedger.slice(-5).reverse();
  const recentLines = recent.length
    ? recent.map((p, i) => {
        const amt = p.currency === "USDT" ? `$${p.amount} USDT` : `Ksh ${p.amount}`;
        return `${i + 1}. *${amt}* — ${p.plan || "—"} | 🧾 \`${p.ref}\` | ${p.paidAt}`;
      }).join("\n")
    : "_No transactions yet_";
  bot.sendMessage(msg.chat.id,
    `💼 *ALJAKI Balance Report*\n\n` +
    `📅 *Today* (${s.todayCount} payment(s))\n  🇰🇪 Ksh *${s.todayKes.toLocaleString()}*\n  💵 *$${s.todayUsdt.toFixed(2)} USDT*\n\n` +
    `📆 *This Week* (${s.weekCount} payment(s))\n  🇰🇪 Ksh *${s.weekKes.toLocaleString()}*\n  💵 *$${s.weekUsdt.toFixed(2)} USDT*\n\n` +
    `🏦 *All-Time* (${s.allCount} total)\n  🇰🇪 Ksh *${s.totalKes.toLocaleString()}*\n  💵 *$${s.totalUsdt.toFixed(2)} USDT*\n\n` +
    `🧾 *Last 5 Transactions*\n${recentLines}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/ledger/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  if (!paymentLedger.length) return bot.sendMessage(msg.chat.id, "📭 No payments recorded yet.");
  const lines = paymentLedger.map((p, i) => {
    const amt = p.currency === "USDT" ? `$${p.amount} USDT` : `Ksh ${p.amount}`;
    return `${i + 1}. *${amt}* | ${p.package || "—"} ${p.plan || ""} | 🆔 \`${p.chatId}\` | 🧾 \`${p.ref}\` | ${p.paidAt}`;
  });
  const chunks = [];
  let chunk = `📋 *Full Payment Ledger (${paymentLedger.length} total)*\n\n`;
  for (const line of lines) {
    if ((chunk + line).length > 3800) { chunks.push(chunk); chunk = ""; }
    chunk += line + "\n";
  }
  chunks.push(chunk);
  chunks.forEach((c) => bot.sendMessage(msg.chat.id, c, { parse_mode: "Markdown" }).catch(() => {}));
});

bot.onText(/\/kick (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  const targetId = Number(match[1]);
  try {
    await bot.banChatMember(CHANNEL_ID, targetId);
    await bot.unbanChatMember(CHANNEL_ID, targetId);
    clearSubTimers(String(targetId));
    bot.sendMessage(targetId,
      `👋 *Your access has been removed.*\n\nWe hope you enjoyed your time! 🙏\n\nReady to come back? Tap below 😊`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] } }
    ).catch(() => {});
    bot.sendMessage(msg.chat.id, `✅ User \`${targetId}\` removed.`, { parse_mode: "Markdown" });
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`);
  }
});

bot.onText(/\/subs/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  const entries = Object.entries(subTimers);
  if (!entries.length) return bot.sendMessage(msg.chat.id, "📭 No active subscriptions.");
  const lines = entries.map(([id, t]) => {
    const exp = t.expiresAt ? moment(t.expiresAt).format("DD MMM YYYY, HH:mm") : "unknown";
    return `• \`${id}\` — ${(userSelections[id] || {}).plan || "?"} | expires ${exp}`;
  });
  bot.sendMessage(msg.chat.id, `🔐 *Active Subscriptions (${entries.length})*\n\n${lines.join("\n")}\n\n_/kick <chatId> to remove_`, { parse_mode: "Markdown" });
});

bot.onText(/\/reply (\d+) (.+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  bot.sendMessage(match[1], `💬 *Message from Support*\n\n${match[2]}`, { parse_mode: "Markdown" })
    .then(() => bot.sendMessage(msg.chat.id, `✅ Reply sent to \`${match[1]}\``, { parse_mode: "Markdown" }))
    .catch((err) => bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`));
});

// ─── INCOMING TEXT MESSAGES ──────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const text   = msg.text.trim();
  const sel    = userSelections[chatId];

  // ── Handle M-Pesa receipt code submitted by user ──────────────────────────
  if (awaitingReceipt[chatId]) {
    const receiptInfo = awaitingReceipt[chatId];
    delete awaitingReceipt[chatId];

    const code = text.toUpperCase();

    if (!/^[A-Z0-9]{10}$/.test(code)) {
      return bot.sendMessage(chatId,
        `⚠️ That doesn't look like a valid M-Pesa code.\n\nM-Pesa codes are *10 characters* long, e.g. \`RCX4B2K9QP\`.\n\nPlease check your SMS and try again, or tap below for help.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "❓ I Need Help", callback_data: "need_help" }],
              [{ text: "🔄 Try Again",   callback_data: "pay_stk" }]
            ]
          }
        }
      );
    }

    // Alert admins with one-tap approve button
    notifyAdmins(
      `🔔 *Manual Receipt Submitted*\n\n` +
      `👤 ChatID: \`${chatId}\`\n` +
      `📦 ${receiptInfo.pkg || "N/A"} — ${receiptInfo.plan || "N/A"}\n` +
      `💰 Ksh ${receiptInfo.price || "N/A"}\n` +
      `🧾 M-Pesa Code: \`${code}\`\n\n` +
      `Please verify on M-Pesa then tap below to approve 👇`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: `✅ Approve & Send Access to ${chatId}`, callback_data: `admin_grant_${chatId}_${receiptInfo.plan || "1 Month"}` }
          ]]
        }
      }
    );

    return bot.sendMessage(chatId,
      `✅ *Thank you!*\n\n` +
      `We've received your M-Pesa code \`${code}\` and our team is verifying it right now. 🔍\n\n` +
      `You'll receive your access link within a few minutes. We appreciate your patience! 🙏`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Handle phone number for STK push ─────────────────────────────────────
  if (sel && sel.awaitingPhone) {
    sel.awaitingPhone = false;
    userSelections[chatId] = sel;

    const cleaned = text.replace(/^\+/, "").replace(/^0/, "254");

    if (!/^2547\d{8}$|^2541\d{8}$/.test(cleaned)) {
      return bot.sendMessage(chatId,
        `⚠️ *Invalid phone number.*\n\nPlease enter a valid Safaricom number:\n• *07XXXXXXXX*\n• *01XXXXXXXX*`,
        { parse_mode: "Markdown" }
      );
    }

    await sendTyping(chatId, 1000);
    await bot.sendMessage(chatId,
      `⏳ *Sending STK push to ${text}...*\n\nCheck your phone and enter your M-Pesa PIN. 📲`,
      { parse_mode: "Markdown" }
    );

    try {
      const result = await stkPush(text, sel.price, chatId);
      if (result.ResponseCode === "0") {
        await bot.sendMessage(chatId,
          `✅ *Payment prompt sent!*\n\nEnter your M-Pesa PIN to complete. Access will be sent automatically once confirmed. 🔐\n\n` +
          `_If you've already paid but don't receive access within 2 minutes, tap the button below._`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ I've Paid — Confirm Access", callback_data: "confirm_payment" }],
                [{ text: "❓ I Need Help",                 callback_data: "need_help" }]
              ]
            }
          }
        );
      } else {
        await bot.sendMessage(chatId,
          `⚠️ *Could not send payment prompt.*\n\nReason: _${result.ResponseDescription || "Unknown error"}_\n\nPay manually via M-Pesa till instead 👇`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
                [{ text: "🔄 Try STK Again",         callback_data: "pay_stk" }],
                [{ text: "❓ I Need Help",            callback_data: "need_help" }]
              ]
            }
          }
        );
      }
    } catch (err) {
      await bot.sendMessage(chatId,
        `❌ *Payment request failed.*\n\n_${err.response?.data?.errorMessage || err.message}_\n\nYou can still pay manually 👇`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
              [{ text: "❓ I Need Help",            callback_data: "need_help" }]
            ]
          }
        }
      );
    }
    return;
  }

  if (sel && !sel.paidAt) {
    bot.sendMessage(chatId,
      `👋 Still here! Use the buttons below to continue, or type /start to begin again.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Continue Purchase", callback_data: "pay_stk" }],
            [{ text: "🔄 Start Over",        callback_data: "change_package" }]
          ]
        }
      }
    ).catch(() => {});
  }
});

// ─── CALLBACK QUERIES ────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});
  await sendTyping(chatId, 600);

  // ── Admin one-tap grant button (sent on auto-invite failure or receipt) ───
  if (data.startsWith("admin_grant_")) {
    if (!ADMIN_IDS.includes(String(chatId))) return;
    // callback_data format: admin_grant_<targetChatId>_<plan words...>
    // e.g. admin_grant_6954749470_1 Month
    const withoutPrefix = data.replace("admin_grant_", ""); // "6954749470_1 Month"
    const underscoreIdx = withoutPrefix.indexOf("_");
    const targetChatId  = Number(withoutPrefix.substring(0, underscoreIdx));
    const planLabel     = withoutPrefix.substring(underscoreIdx + 1); // "1 Month"

    try {
      await grantAccess(
        targetChatId,
        planLabel || "1 Month",
        `✅ Access verified and granted by admin\n📦 Plan: *${planLabel || "1 Month"}*`
      );
      bot.sendMessage(chatId, `✅ Access granted to \`${targetChatId}\` for *${planLabel}*`, { parse_mode: "Markdown" });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed: ${err.message}`);
    }
    return;
  }

  // ── Package selection ─────────────────────────────────────────────────────
  if (data === "package_naughty_premium_leaks") {
    userSelections[chatId] = { package: "Naughty Premium Leaks" };
    return bot.sendMessage(chatId,
      `🔥 *Great choice!* Naughty Premium Leaks is our most popular package.\n\nPick your plan:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 40",                     callback_data: "naughty_1day" }],
            [{ text: "1 Week — Ksh 170",                   callback_data: "naughty_1week" }],
            [{ text: "2 Weeks — Ksh 270",                  callback_data: "naughty_2weeks" }],
            [{ text: "1 Month — Ksh 450",                  callback_data: "naughty_1month" }],
            [{ text: "6 Months — Ksh 2,500 🔥 Best Value", callback_data: "naughty_6months" }],
            [{ text: "1 Year — Ksh 6,200 👑 VIP",          callback_data: "naughty_1year" }]
          ]
        }
      }
    );
  }

  if (data === "package_naughty_explicit") {
    userSelections[chatId] = { package: "Naughty Explicit" };
    return bot.sendMessage(chatId,
      `💥 *You picked Naughty Explicit!* Free Hookups included.\n\nChoose your plan:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 50",                     callback_data: "premium_1day" }],
            [{ text: "1 Week — Ksh 220",                   callback_data: "premium_1week" }],
            [{ text: "2 Weeks — Ksh 400",                  callback_data: "premium_2weeks" }],
            [{ text: "1 Month — Ksh 680",                  callback_data: "premium_1month" }],
            [{ text: "6 Months — Ksh 3,500 🔥 Best Value", callback_data: "premium_6months" }],
            [{ text: "1 Year — Ksh 7,000 👑 VIP",          callback_data: "premium_1year" }]
          ]
        }
      }
    );
  }

  if (data === "back_to_package_naughty_premium_leaks") {
    userSelections[chatId] = { package: "Naughty Premium Leaks" };
    return bot.sendMessage(chatId, `🔥 *Naughty Premium Leaks* — pick your plan:`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Day — Ksh 40",                     callback_data: "naughty_1day" }],
          [{ text: "1 Week — Ksh 170",                   callback_data: "naughty_1week" }],
          [{ text: "2 Weeks — Ksh 270",                  callback_data: "naughty_2weeks" }],
          [{ text: "1 Month — Ksh 450",                  callback_data: "naughty_1month" }],
          [{ text: "6 Months — Ksh 2,500 🔥 Best Value", callback_data: "naughty_6months" }],
          [{ text: "1 Year — Ksh 6,200 👑 VIP",          callback_data: "naughty_1year" }]
        ]
      }
    });
  }

  if (data === "back_to_package_naughty_explicit") {
    userSelections[chatId] = { package: "Naughty Explicit" };
    return bot.sendMessage(chatId, `💥 *Naughty Explicit* — pick your plan:`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Day — Ksh 50",                     callback_data: "premium_1day" }],
          [{ text: "1 Week — Ksh 220",                   callback_data: "premium_1week" }],
          [{ text: "2 Weeks — Ksh 400",                  callback_data: "premium_2weeks" }],
          [{ text: "1 Month — Ksh 680",                  callback_data: "premium_1month" }],
          [{ text: "6 Months — Ksh 3,500 🔥 Best Value", callback_data: "premium_6months" }],
          [{ text: "1 Year — Ksh 7,000 👑 VIP",          callback_data: "premium_1year" }]
        ]
      }
    });
  }

  if (data === "change_package") {
    return bot.sendMessage(chatId, `🔄 *Choose a package:*`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks",          callback_data: "package_naughty_premium_leaks" }],
          [{ text: "💥 Naughty Explicit (Free Hookups)", callback_data: "package_naughty_explicit" }]
        ]
      }
    });
  }

  // ── Plan selection ────────────────────────────────────────────────────────
  if (PLANS[data]) {
    const plan = PLANS[data];
    const sel  = userSelections[chatId] || {};
    sel.plan   = plan.label;
    sel.price  = plan.price;
    userSelections[chatId] = sel;

    const backTarget = data.startsWith("naughty_") ? "package_naughty_premium_leaks" : "package_naughty_explicit";
    scheduleReminders(chatId);

    const usdtPlan = USDT_PLANS.find((p) => p.label === plan.label);
    const keyboard = [
      [{ text: `📲 Pay via STK Push (Recommended)`, callback_data: "pay_stk" }],
      ...(usdtPlan ? [[{ text: `₿ Pay with Crypto  ($${usdtPlan.usdt} USDT)`, callback_data: "pay_usdt" }]] : []),
      [{ text: `⬅️ Change Plan`, callback_data: `back_to_${backTarget}` }]
    ];

    return bot.sendMessage(chatId,
      `✅ *${sel.package}* — *${plan.label}* selected\n💰 Ksh *${plan.price}*\n\nHow would you like to pay?`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }
    );
  }

  if (data === "pay_stk") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) return bot.sendMessage(chatId, "⚠️ Please start over with /start.");
    userSelections[chatId].awaitingPhone = true;
    return bot.sendMessage(chatId,
      `📱 *Enter your M-Pesa phone number* and we'll send you a payment prompt.\n\nFormat: *07XXXXXXXX* or *01XXXXXXXX*`,
      { parse_mode: "Markdown" }
    );
  }

  if (data === "pay_usdt") {
    const sel = userSelections[chatId];
    if (!sel || !sel.package) return bot.sendMessage(chatId, "⚠️ Please start over with /start.");
    const isNaughty = sel.package === "Naughty Premium Leaks";
    const backKey   = isNaughty ? "back_to_package_naughty_premium_leaks" : "back_to_package_naughty_explicit";
    return bot.sendMessage(chatId,
      `₿ *Pay with Crypto — Choose Your Plan*\n\nPackage: *${sel.package}*\n\nSelect the plan you want to pay for with USDT:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — $5 USDT",       callback_data: "usdt_1day" }],
            [{ text: "1 Week — $19 USDT",      callback_data: "usdt_1week" }],
            [{ text: "1 Month — $35 USDT",     callback_data: "usdt_1month" }],
            [{ text: "6 Months — $90 USDT 🔥", callback_data: "usdt_6months" }],
            [{ text: "1 Year — $250 USDT 👑",  callback_data: "usdt_1year" }],
            [{ text: "⬅️ Back",                 callback_data: backKey }]
          ]
        }
      }
    );
  }

  if (data.startsWith("usdt_")) {
    const planMap = {
      usdt_1day:    { label: "1 Day",    usdt: 5 },
      usdt_1week:   { label: "1 Week",   usdt: 19 },
      usdt_1month:  { label: "1 Month",  usdt: 35 },
      usdt_6months: { label: "6 Months", usdt: 90 },
      usdt_1year:   { label: "1 Year",   usdt: 250 },
    };
    const chosen = planMap[data];
    if (!chosen) return;

    const sel = userSelections[chatId] || {};
    sel.plan  = chosen.label;
    const kesKey = (sel.package === "Naughty Premium Leaks" ? "naughty_" : "premium_") +
                   chosen.label.toLowerCase().replace(" ", "");
    sel.price      = PLANS[kesKey]?.price || 0;
    sel.usdtAmount = chosen.usdt;
    userSelections[chatId] = sel;
    clearReminders(chatId);

    await bot.sendMessage(chatId,
      `₿ *Pay with Crypto (USDT)*\n\n📦 *${sel.package}* — *${chosen.label}*\n💰 Amount: *$${chosen.usdt} USDT*\n\n` +
      `🌍 *Why crypto?*\n• 100% Anonymous — no name, no bank, no trace\n• Auto-detected — access sent the moment we see your payment\n• Secure & global — works from anywhere`,
      { parse_mode: "Markdown" }
    );

    await bot.sendMessage(chatId,
      `📤 *Send Payment*\n\nSend *exactly $${chosen.usdt} USDT* to:\n\n\`${USDT_WALLET}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n🚨 *IMPORTANT — READ BEFORE SENDING* 🚨\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `✅ *CORRECT network:* Tron (TRC20) *ONLY*\n❌ *WRONG:* ERC20 / BEP20 / Any other network\n\n` +
      `⛔ *Sending to the wrong network = permanent loss of funds. We cannot recover such payments.*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n📋 *Confirm before sending:*\n` +
      `☑️ Sending *USDT* (not TRX)\n☑️ Network is *TRC20 / Tron*\n` +
      `☑️ Address starts with *T*\n☑️ Amount is *exactly $${chosen.usdt} USDT*\n\n` +
      `⏳ Payment window: *30 minutes*\n\n_We're watching for your transaction. Access will be sent automatically once detected._ 🔍`,
      { parse_mode: "Markdown" }
    );

    await startUsdtPoller(chatId, chosen.usdt);
    return;
  }

  if (data === "show_till") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) return bot.sendMessage(chatId, "⚠️ Please start over with /start.");
    return bot.sendMessage(chatId,
      `💳 *Manual M-Pesa Payment*\n\n\`\`\`\n${tillCard(sel.package, sel.plan, sel.price)}\n\`\`\`\n\n` +
      `📲 *Steps:*\n➊ Open M-Pesa\n➋ Lipa na M-Pesa → *Buy Goods & Services*\n` +
      `➌ Till: *${TILL_NUMBER}*\n➍ Amount: *Ksh ${sel.price}*\n➎ Confirm with PIN\n\n` +
      `_Once done, tap below to confirm._ ✅`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ I've Paid — Confirm My Access", callback_data: "confirm_payment" }],
            [{ text: "📲 Try STK Push Instead",          callback_data: "pay_stk" }],
            [{ text: "❓ I Need Help",                    callback_data: "need_help" }]
          ]
        }
      }
    );
  }

  // ── Confirm payment — ask for M-Pesa receipt code ─────────────────────────
  if (data === "confirm_payment") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) return bot.sendMessage(chatId, "⚠️ Please start over with /start.");

    awaitingReceipt[chatId] = {
      plan:  sel.plan    || "1 Month",
      pkg:   sel.package || "N/A",
      price: sel.price   || 0,
    };

    notifyAdmins(
      `🔔 *Payment Claim Received*\n\n👤 \`${chatId}\`\n📦 ${sel.package || "N/A"} — ${sel.plan || "N/A"}\n💰 Ksh ${sel.price}\n\n_Waiting for user to submit M-Pesa confirmation code..._`
    );

    return bot.sendMessage(chatId,
      `📋 *Almost done!*\n\n` +
      `Please type your *M-Pesa confirmation code* from your payment SMS.\n\n` +
      `It looks like this: \`RCX4B2K9QP\` — 10 characters\n\n` +
      `This helps us verify your payment quickly and send your access right away. 🔍`,
      { parse_mode: "Markdown" }
    );
  }

  if (data === "need_help") {
    return bot.sendMessage(chatId,
      `🛠️ *Need Help?*\n\n` +
      `• *STK push not arriving?* Make sure your number is active on M-Pesa and try again.\n` +
      `• *Payment deducted but no access?* Tap "I've Paid" and enter your M-Pesa code.\n` +
      `• *Wrong amount?* Go back and reselect your plan.\n\n` +
      `Still stuck? An admin will assist you shortly. 👇`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Try STK Again",  callback_data: "pay_stk" }],
            [{ text: "💳 Manual Till",     callback_data: "show_till" }],
            [{ text: "🔁 Change Package",  callback_data: "change_package" }]
          ]
        }
      }
    );
  }

  if (data === "dismiss_reminder") {
    clearReminders(chatId);
    return bot.sendMessage(chatId, `👍 No problem! Use /start whenever you're ready.`);
  }
});

// ─── EXPRESS SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 M-Pesa callback URL: ${CALLBACK_URL || "⚠️ NOT SET"}`);
  console.log(`📺 Channel ID: ${CHANNEL_ID}`);
  console.log(`🌐 Render URL: ${RENDER_URL || "⚠️ NOT SET"}`);

  // ─── KEEP ALIVE (prevents Render free tier from sleeping) ────────────────
  if (RENDER_URL) {
    console.log(`🏓 Keep-alive enabled → pinging ${RENDER_URL} every 10 min`);
    setInterval(() => {
      axios.get(RENDER_URL)
        .then(() => console.log("🏓 Keep-alive ping OK"))
        .catch((err) => console.warn("🏓 Keep-alive ping failed:", err.message));
    }, 10 * 60 * 1000);
  } else {
    console.warn("⚠️ Keep-alive disabled — set RENDER_EXTERNAL_URL in env vars");
  }
});