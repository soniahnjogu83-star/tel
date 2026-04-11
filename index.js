require("dotenv").config();

const express = require("express");
const axios   = require("axios");
const moment  = require("moment");
const TelegramBot = require("node-telegram-bot-api");

// ─── APP SETUP ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TILL_NUMBER   = "4902476";
const TILL_NAME     = "ALJAKI Enterprise";
const ADMIN_IDS     = ["6954749470", "5355760284"];
const SHORTCODE     = process.env.SHORTCODE;
const PASSKEY       = process.env.PASSKEY;
const CONSUMER_KEY  = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const CALLBACK_URL  = process.env.CALLBACK_URL;
const ACCESS_LINK   = process.env.ACCESS_LINK || "";

// ─── CHANNEL CONFIG ──────────────────────────────────────────────────────────
const CHANNEL_ID = "-1001567081082";

const PLAN_DAYS = {
  "1 Day":    1,
  "1 Week":   7,
  "2 Weeks":  14,
  "1 Month":  30,
  "6 Months": 180,
  "1 Year":   365,
};

const subTimers = {};

async function grantAccess(chatId, planLabel, paymentSummary) {
  try {
    const days        = PLAN_DAYS[planLabel] || 30;
    const expireDate  = Math.floor(Date.now() / 1000) + days * 86400;

    const inviteRes = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit:  1,
      expire_date:   expireDate,
      name:          `Access-${chatId}`
    });
    const inviteLink = inviteRes.invite_link;

    await bot.sendMessage(chatId,
      `🎉 *Access Granted!*\n\n` +
      `${paymentSummary}\n\n` +
      `Tap below to join 👇\n${inviteLink}\n\n` +
      `⚠️ This link is *single-use* — it works for you only.\n` +
      `⏳ Your access expires in *${days} day(s)*.\n\n` +
      `_Welcome to the family!_ 🔐`,
      { parse_mode: "Markdown" }
    );

    clearSubTimers(chatId);
    const timers = {};
    timers.expiresAt = Date.now() + days * 86400 * 1000;

    if (days > 1) {
      timers.warnTimer = setTimeout(() => {
        bot.sendMessage(chatId,
          `⏰ *Heads up!*\n\n` +
          `Your *${planLabel}* access expires in *24 hours*.\n\n` +
          `Renew now to stay connected — same great content, waiting for you. 😊`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Renew My Access", callback_data: "change_package" }]
              ]
            }
          }
        ).catch(() => {});
      }, (days - 1) * 86400 * 1000);
    }

    timers.kickTimer = setTimeout(async () => {
      try {
        await bot.banChatMember(CHANNEL_ID, chatId);
        await bot.unbanChatMember(CHANNEL_ID, chatId);
      } catch (e) {
        console.error("Kick error:", e.message);
      }
      bot.sendMessage(chatId,
        `👋 *Your access has ended.*\n\n` +
        `Your *${planLabel}* plan has expired. We hope you enjoyed your time with us! 🙏\n\n` +
        `Whenever you're ready to come back, we'll be here — same great content, always fresh. 😊`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Re-subscribe", callback_data: "change_package" }]
            ]
          }
        }
      ).catch(() => {});
      delete subTimers[chatId];
    }, days * 86400 * 1000);

    subTimers[chatId] = timers;
    console.log(`✅ Access granted to ${chatId} | ${planLabel} | expires in ${days}d`);
  } catch (err) {
    console.error("grantAccess error:", err.message);
    notifyAdmins(
      `⚠️ *Auto-invite failed for* \`${chatId}\`\n` +
      `Error: ${err.message}\n\n` +
      `Please send access manually:\n\`/send ${chatId} <link>\``
    );
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
const USDT_WALLET   = "TH25gdz6zpuaxYjWMemKYt8eRjvYVfTFrp";
const USDT_NETWORK  = "TRC20 (Tron)";
const pendingUSDT   = {};

function toUsdt(kshPrice) {
  return parseFloat((kshPrice / 10).toFixed(2));
}

// ─── STORE ───────────────────────────────────────────────────────────────────
const userSelections = {};
const pendingSTK = {};
const reminderTimers = {};

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

// ─── PLANS ───────────────────────────────────────────────────────────────────
const PLANS = {
  naughty_1day:    { label: "1 Day",    price: 30 },
  naughty_1week:   { label: "1 Week",   price: 150 },
  naughty_2weeks:  { label: "2 Weeks",  price: 250 },
  naughty_1month:  { label: "1 Month",  price: 450 },
  naughty_6months: { label: "6 Months", price: 2500 },
  naughty_1year:   { label: "1 Year",   price: 5000 },
  premium_1day:    { label: "1 Day",    price: 42 },
  premium_1week:   { label: "1 Week",   price: 200 },
  premium_2weeks:  { label: "2 Weeks",  price: 400 },
  premium_1month:  { label: "1 Month",  price: 650 },
  premium_6months: { label: "6 Months", price: 3000 },
  premium_1year:   { label: "1 Year",   price: 6000 },
};

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
    `║  📦 ${packageName.substring(0, 22).padEnd(22)}║\n` +
    `║  ⏱  Plan: ${plan.padEnd(18)}║\n` +
    `║  💰 Amount: Ksh ${String(price).padEnd(11)}║\n` +
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
      text:
        `👋 Hey, just checking in — did you run into any trouble during checkout?\n\n` +
        `Sometimes M-Pesa gets a little moody. If anything went sideways, I'm here to sort it out. 🛠️\n\n` +
        `Or if you're still thinking about it — your *${pkg}* spot is still open. 😊`,
      keyboard: [
        [{ text: "✅ Complete My Purchase", callback_data: "show_till" }],
        [{ text: "⚠️ I Had an Issue", callback_data: "need_help" }],
        [{ text: "🚫 Not Interested", callback_data: "dismiss_reminder" }]
      ]
    },
    {
      delay: 30 * 60 * 1000,
      text:
        `🔍 Noticed your session is still open — no pressure at all, just wanted to make sure everything's good on your end.\n\n` +
        `Your selected plan${price ? ` (*Ksh ${price}*)` : ""} is waiting whenever you're ready. Take your time. ⏳`,
      keyboard: [
        [{ text: "💳 I'm Ready to Pay", callback_data: "show_till" }],
        [{ text: "🔄 See Packages Again", callback_data: "change_package" }],
        [{ text: "🚫 Dismiss", callback_data: "dismiss_reminder" }]
      ]
    },
    {
      delay: 2 * 60 * 60 * 1000,
      text:
        `💡 Quick thought — a lot of people who hesitated at first said it was *100% worth it* after they joined.\n\n` +
        `If there's anything holding you back (price, payment, anything), just say the word and we'll figure it out together. 🤝`,
      keyboard: [
        [{ text: "💬 I Have a Question", callback_data: "need_help" }],
        [{ text: "✅ Let's Do This", callback_data: "show_till" }],
        [{ text: "🚫 No Thanks", callback_data: "dismiss_reminder" }]
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

// ─── M-PESA: GET ACCESS TOKEN (PRODUCTION) ───────────────────────────────────
async function getMpesaToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  const res = await axios.get(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", // ✅ PRODUCTION
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

// ─── M-PESA: STK PUSH (PRODUCTION) ───────────────────────────────────────────
async function stkPush(phone, amount, chatId) {
  const token     = await getMpesaToken();
  const timestamp = moment().format("YYYYMMDDHHmmss");
  const password  = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString("base64");

  const normalized = phone.replace(/^0/, "254").replace(/^\+/, "");

  const payload = {
    BusinessShortCode: SHORTCODE,
    Password:          password,
    Timestamp:         timestamp,
    TransactionType:   "CustomerBuyGoodsOnline",
    Amount:            amount,
    PartyA:            normalized,
    PartyB:            TILL_NUMBER,
    PhoneNumber:       normalized,
    CallBackURL:       CALLBACK_URL,
    AccountReference:  "ALJAKI",
    TransactionDesc:   "Content Access"
  };

  const res = await axios.post(
    "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", // ✅ PRODUCTION
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (res.data.ResponseCode === "0") {
    pendingSTK[res.data.CheckoutRequestID] = chatId;
    console.log(`📲 STK Push sent | CheckoutID: ${res.data.CheckoutRequestID} | chatId: ${chatId}`);
  }

  return res.data;
}

// ─── M-PESA CALLBACK ──────────────────────────────────────────────────────────
app.post("/mpesa/callback", (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

  console.log("📩 M-Pesa callback received:", JSON.stringify(req.body, null, 2));

  try {
    const body     = req.body?.Body?.stkCallback;
    const checkId  = body?.CheckoutRequestID;
    const code     = body?.ResultCode;
    const chatId   = pendingSTK[checkId];

    if (!chatId) {
      console.warn(`⚠️ No chatId found for CheckoutRequestID: ${checkId}`);
      return;
    }
    delete pendingSTK[checkId];

    if (code === 0) {
      const meta      = body.CallbackMetadata?.Item || [];
      const get       = (name) => meta.find((i) => i.Name === name)?.Value ?? "—";
      const amount    = get("Amount");
      const mpesaCode = get("MpesaReceiptNumber");
      const phone     = get("PhoneNumber");

      const sel = userSelections[chatId] || {};
      sel.paidAt  = new Date().toISOString();
      sel.stkRef  = mpesaCode;
      sel.phone   = phone;
      userSelections[chatId] = sel;

      clearReminders(chatId);

      recordPayment({
        chatId,
        username: sel.username || String(chatId),
        pkg:      sel.package,
        plan:     sel.plan,
        amount,
        ref:      mpesaCode,
        phone
      });

      const summary = `✅ Ksh *${amount}* received via M-Pesa\n🧾 Ref: \`${mpesaCode}\``;
      grantAccess(chatId, sel.plan || "1 Month", summary);

      notifyAdmins(
        `💰 *PAYMENT CONFIRMED (STK Push)*\n\n` +
        `👤 Chat ID: \`${chatId}\`\n` +
        `📦 Package: *${sel.package || "N/A"}*\n` +
        `⏱  Plan: *${sel.plan || "N/A"}*\n` +
        `💰 Amount: *Ksh ${amount}*\n` +
        `🧾 M-Pesa Ref: \`${mpesaCode}\`\n` +
        `📱 Phone: ${phone}\n\n` +
        `➡️ Send access with:\n\`/send ${chatId} <link>\``
      );
    } else {
      console.log(`❌ STK failed | ResultCode: ${code} | chatId: ${chatId}`);
      bot.sendMessage(chatId,
        `⚠️ *Payment wasn't completed.*\n\n` +
        `No worries — it happens! You can try again below or use the manual M-Pesa option.\n\n` +
        `_Did something go wrong? Tap "I Need Help" and we'll sort it out._ 🛠️`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Try Again", callback_data: "show_till" }],
              [{ text: "❓ I Need Help", callback_data: "need_help" }]
            ]
          }
        }
      ).catch(() => {});
    }
  } catch (err) {
    console.error("STK Callback error:", err.message);
  }
});

// ─── USDT: POLL TRONGRID ──────────────────────────────────────────────────────
async function startUsdtPoller(chatId, expectedUsdt) {
  stopUsdtPoller(chatId);

  const expiresAt = Date.now() + 30 * 60 * 1000;
  const startTime = Math.floor(Date.now() / 1000) - 60;

  const intervalId = setInterval(async () => {
    try {
      if (Date.now() > expiresAt) {
        stopUsdtPoller(chatId);
        bot.sendMessage(chatId,
          `⏰ *Payment window expired.*\n\nYour USDT payment wasn't detected within 30 minutes.\n\nNo worries — tap below to try again or switch to M-Pesa.`,
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
      const url = `https://api.trongrid.io/v1/accounts/${USDT_WALLET}/transactions/trc20` +
        `?contract_address=${USDT_CONTRACT}&limit=20&min_timestamp=${startTime * 1000}`;

      const res = await axios.get(url, {
        headers: { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY || "" }
      });

      const txns = res.data?.data || [];
      for (const tx of txns) {
        if (tx.to?.toLowerCase() !== USDT_WALLET.toLowerCase()) continue;
        const received = parseFloat(tx.value) / 1_000_000;
        if (received >= expectedUsdt) {
          stopUsdtPoller(chatId);
          clearReminders(chatId);

          const sel = userSelections[chatId] || {};
          sel.paidAt  = new Date().toISOString();
          sel.stkRef  = tx.transaction_id;
          userSelections[chatId] = sel;

          recordPayment({
            chatId,
            username: sel.username || String(chatId),
            pkg:      sel.package,
            plan:     sel.plan,
            amount:   received,
            ref:      tx.transaction_id,
            phone:    "USDT",
            currency: "USDT"
          });

          const usdtSummary = `✅ *$${received} USDT* received\n🧾 TxID: \`${tx.transaction_id.substring(0, 20)}...\``;
          grantAccess(chatId, sel.plan || "1 Month", usdtSummary);

          notifyAdmins(
            `💵 *USDT PAYMENT CONFIRMED*\n\n` +
            `👤 Chat ID: \`${chatId}\`\n` +
            `📦 Package: *${sel.package || "N/A"}*\n` +
            `⏱  Plan: *${sel.plan || "N/A"}*\n` +
            `💰 Amount: *$${received} USDT*\n` +
            `🧾 TxID: \`${tx.transaction_id}\`\n\n` +
            `➡️ Send access with:\n\`/send ${chatId} <link>\``
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
bot.onText(/\/start/, (msg) => {
  const chatId   = msg.chat.id;
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  console.log(`👤 /start — ${username} (${chatId})`);

  bot.sendMessage(chatId,
    `Welcome ${username} 🚀\n\nSelect your preferred package below:`,
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

// ─── /myid ────────────────────────────────────────────────────────────────────
bot.onText(/\/myid/, (msg) => {
  bot.sendMessage(msg.chat.id, `🆔 Your Chat ID: \`${msg.chat.id}\``, { parse_mode: "Markdown" });
});

// ─── /testadmin ───────────────────────────────────────────────────────────────
bot.onText(/\/testadmin/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  notifyAdmins(`🧪 *Test Notification*\nTriggered by: \`${msg.chat.id}\``);
  bot.sendMessage(msg.chat.id, "✅ Test sent to all admins.");
});

// ─── /buy ─────────────────────────────────────────────────────────────────────
bot.onText(/\/buy/, (msg) => {
  const chatId = msg.chat.id;
  const sel    = userSelections[chatId];

  if (!sel || !sel.price) {
    return bot.sendMessage(chatId, "⚠️ Please select a package and plan first using /start.");
  }

  bot.sendMessage(chatId,
    `✅ *Almost there!*\n\n\`\`\`\n${tillCard(sel.package, sel.plan, sel.price)}\n\`\`\`\n\n` +
    `📲 *How to pay:*\n` +
    `1️⃣ Open M-Pesa → *Lipa na M-Pesa → Buy Goods*\n` +
    `2️⃣ Till: *${TILL_NUMBER}*\n` +
    `3️⃣ Amount: *Ksh ${sel.price}*\n` +
    `4️⃣ Enter PIN & confirm\n\n` +
    `After paying, tap below 👇`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ I've Paid — Confirm My Access", callback_data: "confirm_payment" }],
          [{ text: "🔄 Change Package",                callback_data: "change_package" }],
          [{ text: "❓ I Need Help",                    callback_data: "need_help" }]
        ]
      }
    }
  );
});

// ─── ADMIN: /send <chatId> <link> ─────────────────────────────────────────────
bot.onText(/\/send (\d+) ([\S]+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  const targetChatId = match[1];
  const accessLink   = match[2];

  const sel = userSelections[targetChatId] || {};
  bot.sendMessage(targetChatId,
    `🎉 *Access Granted!*\n\n` +
    `Your payment has been verified ✅\n\n` +
    `Here's your exclusive link 👇\n${accessLink}\n\n` +
    `_Welcome to the family. Do not share this link._ 🔐`,
    { parse_mode: "Markdown" }
  ).then(() => {
    bot.sendMessage(msg.chat.id, `✅ Access link sent to \`${targetChatId}\``, { parse_mode: "Markdown" });
    if (sel.plan) {
      const days = PLAN_DAYS[sel.plan] || 30;
      clearSubTimers(targetChatId);
      const timers = {};
      timers.expiresAt = Date.now() + days * 86400 * 1000;
      if (days > 1) {
        timers.warnTimer = setTimeout(() => {
          bot.sendMessage(targetChatId,
            `⏰ *Heads up!*\n\nYour *${sel.plan}* access expires in *24 hours*.\n\nRenew now to stay connected 😊`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Renew", callback_data: "change_package" }]] } }
          ).catch(() => {});
        }, (days - 1) * 86400 * 1000);
      }
      timers.kickTimer = setTimeout(async () => {
        try { await bot.banChatMember(CHANNEL_ID, targetChatId); await bot.unbanChatMember(CHANNEL_ID, targetChatId); } catch(e) {}
        bot.sendMessage(targetChatId,
          `👋 *Your access has ended.*\n\nYour *${sel.plan}* plan has expired. Hope you enjoyed it! 🙏\n\nCome back anytime 😊`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] } }
        ).catch(() => {});
        delete subTimers[targetChatId];
      }, days * 86400 * 1000);
      subTimers[targetChatId] = timers;
    }
  }).catch((err) => {
    bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`);
  });
});

// ─── ADMIN: /users ────────────────────────────────────────────────────────────
bot.onText(/\/users/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  const entries = Object.entries(userSelections);
  if (!entries.length) {
    return bot.sendMessage(msg.chat.id, "📭 No active user sessions.");
  }
  const lines = entries.map(([id, s]) =>
    `• \`${id}\` — ${s.package || "—"} / ${s.plan || "—"} / Ksh ${s.price || "—"}${s.paidAt ? " ✅ PAID" : ""}`
  );
  bot.sendMessage(msg.chat.id,
    `👥 *Active Sessions (${entries.length})*\n\n${lines.join("\n")}`,
    { parse_mode: "Markdown" }
  );
});

// ─── ADMIN: /broadcast ────────────────────────────────────────────────────────
bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  const text    = match[1];
  const targets = Object.keys(userSelections);
  if (!targets.length) {
    return bot.sendMessage(msg.chat.id, "📭 No users to broadcast to.");
  }
  targets.forEach((id) => {
    bot.sendMessage(id, `📢 *Announcement*\n\n${text}`, { parse_mode: "Markdown" }).catch(() => {});
  });
  bot.sendMessage(msg.chat.id, `📣 Broadcast sent to *${targets.length}* user(s).`, { parse_mode: "Markdown" });
});

// ─── ADMIN: /stats ────────────────────────────────────────────────────────────
bot.onText(/\/stats/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  const all        = Object.values(userSelections);
  const paid       = all.filter((s) => s.paidAt).length;
  const unpaid     = all.length - paid;
  const revenue    = all.filter((s) => s.paidAt && s.price).reduce((sum, s) => sum + Number(s.price), 0);
  const usdtPending = Object.keys(pendingUSDT).length;

  bot.sendMessage(msg.chat.id,
    `📊 *Bot Stats*\n\n` +
    `👥 Total Sessions: *${all.length}*\n` +
    `✅ Paid: *${paid}*\n` +
    `⏳ Pending: *${unpaid}*\n` +
    `💵 Awaiting USDT: *${usdtPending}*\n` +
    `💰 Total Revenue: *Ksh ${revenue.toLocaleString()}*`,
    { parse_mode: "Markdown" }
  );
});

// ─── ADMIN: /balance ──────────────────────────────────────────────────────────
bot.onText(/\/balance/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  const s = getLedgerStats();
  const recent = paymentLedger.slice(-5).reverse();
  const recentLines = recent.length
    ? recent.map((p, i) => {
        const amt = p.currency === "USDT" ? `$${p.amount} USDT` : `Ksh ${p.amount}`;
        return `${i + 1}. *${amt}* — ${p.plan || "—"} | 🧾 \`${p.ref}\` | ${p.paidAt}`;
      }).join("\n")
    : "_No transactions yet_";

  bot.sendMessage(msg.chat.id,
    `💼 *ALJAKI Balance Report*\n\n` +
    `📅 *Today* (${s.todayCount} payment(s))\n` +
    `  🇰🇪 Ksh *${s.todayKes.toLocaleString()}*\n` +
    `  💵 *$${s.todayUsdt.toFixed(2)} USDT*\n\n` +
    `📆 *This Week* (${s.weekCount} payment(s))\n` +
    `  🇰🇪 Ksh *${s.weekKes.toLocaleString()}*\n` +
    `  💵 *$${s.weekUsdt.toFixed(2)} USDT*\n\n` +
    `🏦 *All-Time* (${s.allCount} total)\n` +
    `  🇰🇪 Ksh *${s.totalKes.toLocaleString()}*\n` +
    `  💵 *$${s.totalUsdt.toFixed(2)} USDT*\n\n` +
    `🧾 *Last 5 Transactions*\n${recentLines}`,
    { parse_mode: "Markdown" }
  );
});

// ─── ADMIN: /ledger ───────────────────────────────────────────────────────────
bot.onText(/\/ledger/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  if (!paymentLedger.length) {
    return bot.sendMessage(msg.chat.id, "📭 No payments recorded yet.");
  }
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

// ─── ADMIN: /kick <chatId> ────────────────────────────────────────────────────
bot.onText(/\/kick (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  const targetId = match[1];
  try {
    await bot.banChatMember(CHANNEL_ID, targetId);
    await bot.unbanChatMember(CHANNEL_ID, targetId);
    clearSubTimers(targetId);
    bot.sendMessage(targetId,
      `👋 *Your access has been removed.*\n\nYour plan has ended. We hope you enjoyed your time with us! 🙏\n\nReady to come back? Tap below 😊`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] } }
    ).catch(() => {});
    bot.sendMessage(msg.chat.id, `✅ User \`${targetId}\` removed from channel.`, { parse_mode: "Markdown" });
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`);
  }
});

// ─── ADMIN: /subs ─────────────────────────────────────────────────────────────
bot.onText(/\/subs/, (msg) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  const entries = Object.entries(subTimers);
  if (!entries.length) return bot.sendMessage(msg.chat.id, "📭 No active subscriptions.");
  const lines = entries.map(([id, t]) => {
    const sel = userSelections[id] || {};
    const exp = t.expiresAt ? moment(t.expiresAt).format("DD MMM YYYY, HH:mm") : "unknown";
    return `• \`${id}\` — ${sel.plan || "?"} | expires ${exp}`;
  });
  bot.sendMessage(msg.chat.id,
    `🔐 *Active Subscriptions (${entries.length})*\n\n${lines.join("\n")}\n\n_To remove early: /kick <chatId>_`,
    { parse_mode: "Markdown" }
  );
});

// ─── ADMIN: /reply <chatId> <message> ─────────────────────────────────────────
bot.onText(/\/reply (\d+) (.+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  const targetId = match[1];
  const text     = match[2];
  bot.sendMessage(targetId, `💬 *Message from Support*\n\n${text}`, { parse_mode: "Markdown" })
    .then(() => bot.sendMessage(msg.chat.id, `✅ Reply sent to \`${targetId}\``, { parse_mode: "Markdown" }))
    .catch((err) => bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`));
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === "package_naughty_premium_leaks") {
    userSelections[chatId] = { package: "Naughty Premium Leaks" };
    return bot.sendMessage(chatId,
      `🔥 *Great choice!* Naughty Premium Leaks is our most popular package.\n\nPick a plan — the longer, the better the value:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 30",                     callback_data: "naughty_1day" }],
            [{ text: "1 Week — Ksh 150",                   callback_data: "naughty_1week" }],
            [{ text: "2 Weeks — Ksh 250",                  callback_data: "naughty_2weeks" }],
            [{ text: "1 Month — Ksh 450",                  callback_data: "naughty_1month" }],
            [{ text: "6 Months — Ksh 2,500 🔥 Best Value", callback_data: "naughty_6months" }],
            [{ text: "1 Year — Ksh 5,000 👑 VIP",          callback_data: "naughty_1year" }]
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
            [{ text: "1 Day — Ksh 42",                     callback_data: "premium_1day" }],
            [{ text: "1 Week — Ksh 200",                   callback_data: "premium_1week" }],
            [{ text: "2 Weeks — Ksh 400",                  callback_data: "premium_2weeks" }],
            [{ text: "1 Month — Ksh 650",                  callback_data: "premium_1month" }],
            [{ text: "6 Months — Ksh 3,000 🔥 Best Value", callback_data: "premium_6months" }],
            [{ text: "1 Year — Ksh 6,000 👑 VIP",          callback_data: "premium_1year" }]
          ]
        }
      }
    );
  }

  if (PLANS[data]) {
    const plan = PLANS[data];
    const sel  = userSelections[chatId] || {};
    sel.plan   = plan.label;
    sel.price  = plan.price;
    userSelections[chatId] = sel;

    const backTarget = data.startsWith("naughty_") ? "package_naughty_premium_leaks" : "package_naughty_explicit";
    scheduleReminders(chatId);
    const usdtPrice = toUsdt(plan.price);

    return bot.sendMessage(chatId,
      `✅ *${sel.package}* — *${plan.label}* selected\n` +
      `💰 Ksh *${plan.price}*\n\n` +
      `How would you like to pay?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: `📲 Pay via STK Push (Auto)`,  callback_data: "pay_stk" }],
            [{ text: `💳 Pay Manually via Till`,     callback_data: "show_till" }],
            [{ text: `₿ Use Crypto Instead`,        callback_data: "pay_usdt" }],
            [{ text: `⬅️ Change Plan`,               callback_data: `back_to_${backTarget}` }]
          ]
        }
      }
    );
  }

  if (data === "pay_stk") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) return bot.sendMessage(chatId, "⚠️ Please start over with /start.");
    userSelections[chatId].awaitingPhone = true;
    return bot.sendMessage(chatId,
      `📱 *Enter your M-Pesa phone number* and we'll send you a payment prompt directly.\n\n` +
      `Format: *07XXXXXXXX* or *01XXXXXXXX*`,
      { parse_mode: "Markdown" }
    );
  }

  if (data === "pay_usdt") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) return bot.sendMessage(chatId, "⚠️ Please start over with /start.");
    const usdtAmount = toUsdt(sel.price);
    sel.usdtAmount = usdtAmount;
    userSelections[chatId] = sel;

    await bot.sendMessage(chatId,
      `₿ *Pay with Crypto*\n\n` +
      `🌍 *Why pay with crypto?*\n` +
      `• ✅ *100% Anonymous* — no name, no bank, no trace\n` +
      `• ⚡ *Instant* — auto-detected, access granted automatically\n` +
      `• 🔒 *Secure* — blockchain-verified, no chargebacks\n` +
      `• 🌐 *Global* — works from anywhere in the world\n` +
      `• 💸 *No middleman* — direct wallet-to-wallet\n\n` +
      `💎 *Accepted:* USDT (TRC20 / Tron Network)\n\n` +
      `📦 *${sel.package}* — *${sel.plan}*\n` +
      `💰 Amount: *$${usdtAmount} USDT*`,
      { parse_mode: "Markdown" }
    );

    await bot.sendMessage(chatId,
      `📤 *Send Payment*\n\n` +
      `Send *exactly $${usdtAmount} USDT* to this TRC20 address:\n\n` +
      `\`${USDT_WALLET}\`\n\n` +
      `⚠️ *Important:*\n` +
      `• Use *TRC20 network only* (Tron)\n` +
      `• Send the exact amount — $${usdtAmount} USDT\n` +
      `• Payment window: *30 minutes*\n\n` +
      `_We're watching for your transaction. Access will be activated automatically once detected._ 🔍`,
      { parse_mode: "Markdown" }
    );

    await startUsdtPoller(chatId, usdtAmount);
    return;
  }

  if (data === "show_till") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) return bot.sendMessage(chatId, "⚠️ Please start over with /start.");
    return bot.sendMessage(chatId,
      `⚡ *Let's get you in!*\n\n` +
      `\`\`\`\n${tillCard(sel.package, sel.plan, sel.price)}\n\`\`\`\n\n` +
      `📲 *Steps:*\n` +
      `➊ Open M-Pesa\n` +
      `➋ Lipa na M-Pesa → *Buy Goods & Services*\n` +
      `➌ Till: *${TILL_NUMBER}*\n` +
      `➍ Amount: *Ksh ${sel.price}*\n` +
      `➎ Confirm with PIN\n\n` +
      `_Once you're done, tap the button below_ 👇`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ I've Paid — Activate My Access", callback_data: "confirm_payment" }],
            [{ text: "📞 I Need Help Paying",             callback_data: "need_help" }]
          ]
        }
      }
    );
  }

  if (data.startsWith("back_to_")) {
    return bot.emit("callback_query", { ...query, data: data.replace("back_to_", "") });
  }

  if (data === "change_package") {
    return bot.sendMessage(chatId, "Sure! Pick a different package below 👇", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks",          callback_data: "package_naughty_premium_leaks" }],
          [{ text: "💥 Naughty Explicit (Free Hookups)", callback_data: "package_naughty_explicit" }]
        ]
      }
    });
  }

  if (data === "confirm_payment") {
    const sel      = userSelections[chatId] || {};
    const username = query.from.username ? `@${query.from.username}` : query.from.first_name;

    notifyAdmins(
      `💰 *Manual Payment Claim*\n\n` +
      `👤 User: ${username}\n` +
      `🆔 Chat ID: \`${chatId}\`\n` +
      `📦 Package: *${sel.package || "N/A"}*\n` +
      `⏱  Plan: *${sel.plan || "N/A"}*\n` +
      `💰 Amount: *Ksh ${sel.price || "N/A"}*\n` +
      `📱 Phone: ${sel.phone || "not provided"}\n\n` +
      `Verify on M-Pesa till *${TILL_NUMBER}* then run:\n\`/send ${chatId} <link>\``
    );

    return bot.sendMessage(chatId,
      `🙏 *Got it!* Your payment is being verified.\n\n` +
      `📦 *${sel.package || "N/A"}* — *${sel.plan || "N/A"}*\n` +
      `💰 Ksh *${sel.price || "N/A"}*\n\n` +
      `Access link coming in *2–5 minutes*. ⚡\n\n` +
      `_Not received after 10 mins? Tap below_ 👇`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔔 Follow Up", callback_data: "follow_up" }]
          ]
        }
      }
    );
  }

  if (data === "follow_up") {
    const sel      = userSelections[chatId] || {};
    const username = query.from.username ? `@${query.from.username}` : query.from.first_name;
    notifyAdmins(
      `⚠️ *Follow-Up Request*\n\n` +
      `👤 ${username} | 🆔 \`${chatId}\`\n` +
      `📦 ${sel.package || "N/A"} — Ksh ${sel.price || "N/A"}\n\n` +
      `User hasn't received access. Check M-Pesa:\n\`/send ${chatId} <link>\``
    );
    return bot.sendMessage(chatId,
      `📋 *Follow-Up Submitted*\n\n` +
      `Please share your:\n` +
      `• M-Pesa *confirmation SMS*\n` +
      `• or the *transaction code* (e.g. RKE2X3ABCD)\n\n` +
      `Reply right here — an admin will activate you ASAP. ⚡`,
      { parse_mode: "Markdown" }
    );
  }

  if (data === "need_help") {
    const sel = userSelections[chatId] || {};
    return bot.sendMessage(chatId,
      `🆘 *Facing an issue? We've got you.*\n\n` +
      `❓ *No M-Pesa?*\n→ Use a friend's phone. Till: *${TILL_NUMBER}*\n\n` +
      `❓ *Transaction failed?*\n→ Check balance. Min: *Ksh ${sel.price || "your plan amount"}*\n\n` +
      `❓ *Wrong amount sent?*\n→ Send your receipt to admin — sorted immediately.\n\n` +
      `💬 Or just reply here and we'll handle it personally.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔁 Try Again",             callback_data: "show_till" }],
            [{ text: "📲 Try STK Push Instead",  callback_data: "pay_stk" }]
          ]
        }
      }
    );
  }

  if (data === "dismiss_reminder") {
    clearReminders(chatId);
    stopUsdtPoller(chatId);
    return bot.sendMessage(chatId, `No worries at all! 👍 If you ever change your mind, just hit /start — we'll be here.`);
  }
});

// ─── MESSAGES: phone capture + STK Push + forward to admins ──────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text;

  if (!text || text.startsWith("/")) return;

  const sel = userSelections[chatId] || {};

  if (/^(\+?254|0)[17]\d{8}$/.test(text.trim())) {
    if (userSelections[chatId]) userSelections[chatId].phone = text.trim();

    if (sel.awaitingPhone && sel.price) {
      userSelections[chatId].awaitingPhone = false;

      await bot.sendMessage(chatId,
        `⏳ *Sending payment request to your phone...*\n\nCheck your M-Pesa prompt and enter your PIN. 📲`,
        { parse_mode: "Markdown" }
      );

      try {
        const result = await stkPush(text.trim(), sel.price, chatId);
        if (result.ResponseCode === "0") {
          return bot.sendMessage(chatId,
            `✅ *M-Pesa prompt sent!*\n\n` +
            `Check your phone — enter your *M-Pesa PIN* to complete the Ksh *${sel.price}* payment.\n\n` +
            `_Access will be activated automatically once payment goes through._ 🔐`,
            { parse_mode: "Markdown" }
          );
        } else {
          throw new Error(result.errorMessage || result.ResponseDescription || "STK push failed");
        }
      } catch (err) {
        console.error("STK Push error:", err.message);
        return bot.sendMessage(chatId,
          `⚠️ Couldn't send the M-Pesa prompt right now.\n\nError: _${err.message}_\n\nYou can pay manually instead — tap below 👇`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }]
              ]
            }
          }
        );
      }
    } else {
      return bot.sendMessage(chatId,
        `📱 Number noted!\n\nComplete your M-Pesa payment to Till *${TILL_NUMBER}* then tap confirm. ✅`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Show Payment Details", callback_data: "show_till" }]
            ]
          }
        }
      );
    }
  }

  if (ADMIN_IDS.includes(String(chatId))) return;

  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  notifyAdmins(
    `💬 *User Message*\n\n` +
    `👤 ${username} | 🆔 \`${chatId}\`\n` +
    `📦 ${sel.package || "no package"} | 💰 Ksh ${sel.price || "—"}\n\n` +
    `📩 _${text}_\n\n` +
    `Reply: \`/reply ${chatId} your message\``
  );
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🤖 ALJAKI Bot live | Till: ${TILL_NUMBER}`);
});