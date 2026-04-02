require("dotenv").config();

const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot is running"));
app.listen(process.env.PORT || 3000);

const TelegramBot = require("node-telegram-bot-api");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TILL_NUMBER = "4902476";
const TILL_NAME   = "ALJAKI Enterprise";
const ADMIN_IDS   = ["6954749470", "5355760284"];

// ─── STORE ───────────────────────────────────────────────────────────────────
const userSelections = {};

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
function notifyAdmins(message) {
  ADMIN_IDS.forEach((adminId) => {
    console.log(`📤 Attempting to notify admin ${adminId}...`);
    bot.sendMessage(adminId, message)
      .then(() => console.log(`✅ Successfully notified admin ${adminId}`))
      .catch((err) => console.error(`❌ FAILED to notify admin ${adminId}: ${err.message}`));
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

function persuasiveUrgency(price, plan) {
  const lines = [
    `🔥 *Only Ksh ${price}* for ${plan} of unlimited access. That's less than a cup of chai. Don't overthink it.`,
    `⚡ Spots are limited. The last person who hesitated missed out. You won't make that mistake.`,
    `🚀 *Move fast.* Your ${plan} starts the moment you pay — not a second before.`,
    `💡 Smart people don't wait for perfect timing. They create it. Pay now, enjoy immediately.`,
    `🎯 At Ksh ${price}, the only bad deal here is *not* getting it.`,
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

// ─── /start ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  console.log(`👤 /start from ${username} (${msg.chat.id})`);
  bot.sendMessage(
    msg.chat.id,
    `Welcome ${username} 🚀\nSelect your preferred package by clicking below:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "1. Naughty Premium Leaks",          callback_data: "package_naughty_premium_leaks" }],
          [{ text: "2. Naughty Explicit (Free Hookups)", callback_data: "package_naughty_explicit" }]
        ]
      }
    }
  );
});

// ─── /myid — lets anyone check their chat ID ─────────────────────────────────
bot.onText(/\/myid/, (msg) => {
  bot.sendMessage(msg.chat.id, `🆔 Your Chat ID is: \`${msg.chat.id}\``, { parse_mode: "Markdown" });
});

// ─── /testadmin — fires a test notification to all admins ────────────────────
bot.onText(/\/testadmin/, (msg) => {
  console.log(`🧪 /testadmin triggered by ${msg.chat.id}`);
  bot.sendMessage(msg.chat.id, "🧪 Firing test to all admins... check your terminal.");
  notifyAdmins(
    `🧪 *Admin Test Notification*\n\nThis is a test.\nTriggered by chat ID: \`${msg.chat.id}\``
  );
});

// ─── /buy ────────────────────────────────────────────────────────────────────
bot.onText(/\/buy/, (msg) => {
  const chatId = msg.chat.id;
  const sel = userSelections[chatId];

  if (!sel || !sel.price) {
    return bot.sendMessage(chatId, "⚠️ Please select a package and plan first using /start before proceeding to pay.");
  }

  bot.sendMessage(
    chatId,
    `✅ *Almost there!* Here's your payment summary:\n\n\`\`\`\n${tillCard(sel.package, sel.plan, sel.price)}\n\`\`\`\n\n` +
    `📲 *How to pay:*\n` +
    `1️⃣ Open M-Pesa on your phone\n` +
    `2️⃣ Go to *Lipa na M-Pesa → Buy Goods*\n` +
    `3️⃣ Enter Till: *${TILL_NUMBER}*\n` +
    `4️⃣ Enter Amount: *Ksh ${sel.price}*\n` +
    `5️⃣ Enter your M-Pesa PIN & confirm\n\n` +
    `${persuasiveUrgency(sel.price, sel.plan)}\n\n` +
    `After paying, tap the button below 👇`,
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

// ─── ADMIN: /send <chatId> <link> ────────────────────────────────────────────
bot.onText(/\/send (\d+) ([\S]+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "⛔ You are not authorized to use this command.");
  }
  const targetChatId = match[1];
  const accessLink   = match[2];
  bot.sendMessage(
    targetChatId,
    `🎉 *Access Granted!*\n\n` +
    `Your payment has been verified. Here is your exclusive link:\n\n` +
    `👉 ${accessLink}\n\n` +
    `_Welcome to the family. Don't share this link._ 🔐`,
    { parse_mode: "Markdown" }
  ).then(() => {
    bot.sendMessage(msg.chat.id, `✅ Access link sent to user \`${targetChatId}\``, { parse_mode: "HTML" });
  }).catch((err) => {
    bot.sendMessage(msg.chat.id, `❌ Failed: ${err.message}`);
  });
});

// ─── ADMIN: /users ───────────────────────────────────────────────────────────
bot.onText(/\/send (\d+) ([\S]+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(String(msg.chat.id))) {
    return bot.sendMessage(msg.chat.id, "You are not authorized to use this command.");
  }
  const targetChatId = match[1];
  const accessLink   = match[2];
  bot.sendMessage(
    targetChatId,
    "🎉 Access Granted!\n\n" +
    "Your payment has been verified. Here is your exclusive link:\n\n" +
    accessLink + "\n\n" +
    "Welcome to the family. Don't share this link. 🔐"
  ).then(() => {
    bot.sendMessage(msg.chat.id, "✅ Access link sent to user " + targetChatId);
  }).catch((err) => {
    bot.sendMessage(msg.chat.id, "❌ Failed: " + err.message);
  });
});

// ─── CALLBACK QUERIES ────────────────────────────────────────────────────────
bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === "package_naughty_premium_leaks") {
    userSelections[chatId] = { package: "Naughty Premium Leaks" };
    bot.sendMessage(chatId,
      `🔥 *Smart choice!* Naughty Premium Leaks is our *most popular* package.\n\nPick a plan — the longer you go, the more you save:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 30 bob",                     callback_data: "naughty_1day" }],
            [{ text: "1 Week — Ksh 150",                   callback_data: "naughty_1week" }],
            [{ text: "2 Weeks — Ksh 250",                  callback_data: "naughty_2weeks" }],
            [{ text: "1 Month — Ksh 450",                  callback_data: "naughty_1month" }],
            [{ text: "6 Months — Ksh 2,500 🔥 Best Value", callback_data: "naughty_6months" }],
            [{ text: "1 Year — Ksh 5,000 👑 VIP",           callback_data: "naughty_1year" }]
          ]
        }
      }
    );
  }

  else if (data === "package_naughty_explicit") {
    userSelections[chatId] = { package: "Naughty Explicit (Free Hookups)" };
    bot.sendMessage(chatId,
      `💣 *Bold move.* Naughty Explicit includes *free hookup connections* — this is the one people don't talk about publicly.\n\nChoose your access window:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 42 bob",                     callback_data: "premium_1day" }],
            [{ text: "1 Week — Ksh 200",                   callback_data: "premium_1week" }],
            [{ text: "2 Weeks — Ksh 400",                  callback_data: "premium_2weeks" }],
            [{ text: "1 Month — Ksh 650",                  callback_data: "premium_1month" }],
            [{ text: "6 Months — Ksh 3,000 🔥 Best Value", callback_data: "premium_6months" }],
            [{ text: "1 Year — Ksh 6,000 👑 VIP",           callback_data: "premium_1year" }]
          ]
        }
      }
    );
  }

  else if (PLANS[data]) {
    const { label, price } = PLANS[data];
    if (!userSelections[chatId]) userSelections[chatId] = {};
    userSelections[chatId].plan  = label;
    userSelections[chatId].price = price;
    const packageName = userSelections[chatId].package || "Selected Package";
    const backTarget  = data.startsWith("naughty_") ? "package_naughty_premium_leaks" : "package_naughty_explicit";
    bot.sendMessage(chatId,
      `💎 *${label}* plan locked in!\n\n` +
      `\`\`\`\n${tillCard(packageName, label, price)}\n\`\`\`\n\n` +
      `${persuasiveUrgency(price, label)}\n\n` +
      `👇 Ready to unlock your access?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: `💳 Pay Ksh ${price} via M-Pesa`, callback_data: "show_till" }],
            [{ text: "⬅️ Change Plan",                  callback_data: `back_to_${backTarget}` }]
          ]
        }
      }
    );
  }

  else if (data === "show_till") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) {
      return bot.sendMessage(chatId, "⚠️ Please start over with /start and select a package first.");
    }
    bot.sendMessage(chatId,
      `⚡ *Let's get you in!*\n\n` +
      `\`\`\`\n${tillCard(sel.package, sel.plan, sel.price)}\n\`\`\`\n\n` +
      `📲 *Steps to pay:*\n` +
      `➊ Open M-Pesa\n` +
      `➋ Lipa na M-Pesa → *Buy Goods & Services*\n` +
      `➌ Till Number: *${TILL_NUMBER}*\n` +
      `➍ Amount: *Ksh ${sel.price}*\n` +
      `➎ Confirm with your PIN\n\n` +
      `_Access is activated once payment is confirmed. No delays — just results._ 🎯`,
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

  else if (data.startsWith("back_to_")) {
    bot.emit("callback_query", { ...query, data: data.replace("back_to_", "") });
  }

  else if (data === "change_package") {
    bot.sendMessage(chatId, "No worries! Pick a different package below 👇", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "1. Naughty Premium Leaks",          callback_data: "package_naughty_premium_leaks" }],
          [{ text: "2. Naughty Explicit (Free Hookups)", callback_data: "package_naughty_explicit" }]
        ]
      }
    });
  }

  else if (data === "confirm_payment") {
    const sel      = userSelections[chatId];
    const username = query.from.username ? `@${query.from.username}` : query.from.first_name;
    console.log(`💰 Payment claim from ${username} (${chatId})`);
    notifyAdmins(
      `💰 *New Payment Claim!*\n\n` +
      `👤 User: ${username}\n` +
      `🆔 Chat ID: \`${chatId}\`\n` +
      `📦 Package: *${sel?.package || "N/A"}*\n` +
      `⏱  Plan: *${sel?.plan || "N/A"}*\n` +
      `💰 Amount: *Ksh ${sel?.price || "N/A"}*\n` +
      `📱 Phone: ${sel?.phone || "not provided"}\n\n` +
      `✅ Verify on M-Pesa till *${TILL_NUMBER}* then send access:\n` +
      `/send ${chatId} <your_channel_link>`
    );
    bot.sendMessage(chatId,
      `🙏 *Thank you!* We've received your payment confirmation.\n\n` +
      `📦 Package: *${sel?.package || "N/A"}*\n` +
      `⏱  Plan: *${sel?.plan || "N/A"}*\n` +
      `💰 Amount: *Ksh ${sel?.price || "N/A"}*\n\n` +
      `Our team will verify your M-Pesa transaction and send your access link within *2–5 minutes*.\n\n` +
      `_If you don't receive access within 10 minutes, tap below 👇_`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔔 Follow Up on My Payment", callback_data: "follow_up" }]
          ]
        }
      }
    );
  }

  else if (data === "follow_up") {
    const sel      = userSelections[chatId];
    const username = query.from.username ? `@${query.from.username}` : query.from.first_name;
    notifyAdmins(
      `⚠️ *Follow-Up Request!*\n\n` +
      `👤 User: ${username}\n` +
      `🆔 Chat ID: \`${chatId}\`\n` +
      `📦 Package: *${sel?.package || "N/A"}*\n` +
      `💰 Amount: *Ksh ${sel?.price || "N/A"}*\n\n` +
      `User has not received access. Check M-Pesa and run:\n` +
      `/send ${chatId} <your_channel_link>`
    );
    bot.sendMessage(chatId,
      `📋 *Payment Follow-Up*\n\n` +
      `Please send us:\n` +
      `• Your *M-Pesa confirmation message*\n` +
      `• Or the *transaction code* (e.g. RKE2X3ABCD)\n\n` +
      `Reply directly here and our admin will activate your access ASAP. ⚡`,
      { parse_mode: "Markdown" }
    );
  }

  else if (data === "need_help") {
    const sel = userSelections[chatId];
    bot.sendMessage(chatId,
      `🆘 *Need Help Paying?*\n\n` +
      `❓ *"I don't have M-Pesa"*\n` +
      `→ Use a friend's phone. Send to Till *${TILL_NUMBER}*.\n\n` +
      `❓ *"My transaction failed"*\n` +
      `→ Check your M-Pesa balance. Min required: *Ksh ${sel?.price || "your plan amount"}*.\n\n` +
      `❓ *"Wrong amount sent"*\n` +
      `→ Contact admin with your receipt — sorted immediately.\n\n` +
      `📩 Still stuck? Reply here and we'll handle it personally. 💪`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔁 Try Payment Again", callback_data: "show_till" }]
          ]
        }
      }
    );
  }

  else if (data === "mpesa") {
    bot.sendMessage(chatId, "📱 Please send your phone number so we can assist you:");
  }
});

// ─── Handle phone number replies ─────────────────────────────────────────────
bot.on("message", (msg) => {
  if (msg.text && /^(\+?254|0)[17]\d{8}$/.test(msg.text.trim())) {
    const chatId = msg.chat.id;
    if (userSelections[chatId]) userSelections[chatId].phone = msg.text.trim();
    bot.sendMessage(chatId,
      `📱 Got it! Number noted.\n\nNow complete your M-Pesa payment to Till *${TILL_NUMBER}* and tap confirm. ✅`,
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
});

console.log("🤖 Bot running — ALJAKI Enterprise | Till: " + TILL_NUMBER);
// ─── Forward user messages to admins ─────────────────────────────────────────
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text;

  // Skip commands
  if (!text || text.startsWith("/")) return;

  // Skip if message is from an admin
  if (ADMIN_IDS.includes(String(chatId))) return;

  const sel      = userSelections[chatId] || {};
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  // Capture phone numbers
  if (/^(\+?254|0)[17]\d{8}$/.test(text.trim())) {
    if (userSelections[chatId]) userSelections[chatId].phone = text.trim();
    bot.sendMessage(chatId,
      `📱 Got it! Number noted.\n\nNow complete your M-Pesa payment to Till *${TILL_NUMBER}* and tap confirm. ✅`,
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

  // Forward everything else to admins
  notifyAdmins(
    `💬 *Message from User*\n\n` +
    `👤 ${username}\n` +
    `🆔 Chat ID: \`${chatId}\`\n` +
    `📦 Package: ${sel.package || "not selected"}\n` +
    `💰 Amount: Ksh ${sel.price || "—"}\n\n` +
    `📩 Message:\n${text}\n\n` +
    `_Reply to them using:_\n` +
    `/send ${chatId} <your_channel_link>`
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});
