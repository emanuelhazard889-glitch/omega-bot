const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const http = require('http'); // ለ Dummy Server

// 1. መሠረታዊ መረጃዎች
const TOKEN = process.env.BOT_TOKEN || '8964045361:AAEUPmbnyad3GukgQZH3oAKSWj8o3O-sE60';
const ADMIN_ID = 8319043148;
const MONGO_URL = process.env.MONGO_URL || 'mongodb+srv://Alpha:406976aaa@cluster0.sgcjmyi.mongodb.net/omega_bot?retryWrites=true&w=majority';
const PROOF_CHANNEL = '@omega_proof'; // የላክከው ቻናል

const bot = new TelegramBot(TOKEN, { polling: true });

// 2. MongoDB Schemas (የመረጃ ቋት አወቃቀር)
mongoose.connect(MONGO_URL).then(() => console.log("Database Connected Successfully")).catch(err => console.log(err));

const User = mongoose.model('User', { 
    userId: Number, 
    balance: { type: Number, default: 0 }, 
    wallet: String, 
    refs: { type: Number, default: 0 }, 
    referrer: Number, 
    verified: { type: Boolean, default: false } 
});

const Channel = mongoose.model('Channel', { 
    channelId: String, 
    link: String 
});

const Config = mongoose.model('Config', { 
    key: String, 
    refReward: { type: Number, default: 2 }, 
    totalWithdrawn: { type: Number, default: 0 } 
});

// State Management
const userStates = {};
let botUsername = '';
bot.getMe().then(me => botUsername = me.username);

// የ Configuration ማስተካከያ 
async function initConfig() {
    let conf = await Config.findOne({ key: "main" });
    if (!conf) await Config.create({ key: "main", refReward: 2, totalWithdrawn: 0 });
}
initConfig();

// --- 3. Start እና Force Join ሎጂክ ---
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const text = match[1].trim();
    
    let referrer = null;
    if (text && !isNaN(text) && Number(text) !== chatId) {
        referrer = Number(text);
    }

    let user = await User.findOne({ userId: chatId });
    if (!user) {
        user = await User.create({ userId: chatId, referrer: referrer });
    }

    sendForceJoin(chatId);
});

async function sendForceJoin(chatId) {
    const channels = await Channel.find();
    let keyboard = [];
    
    channels.forEach((ch, index) => {
        keyboard.push([{ text: `Sponsor ${index + 1}`, url: ch.link }]);
    });
    keyboard.push([{ text: "✅ Verify", callback_data: "verify" }]);

    bot.sendMessage(chatId, "በቅድሚያ እነዚህን ቻናሎች ይቀላቀሉ፡", {
        reply_markup: { inline_keyboard: keyboard }
    });
}

// ዋናውን ሜኑ ወደ Reply Keyboard መቀየር (ከታች ኪቦርድ ላይ የሚመጣው)
function showMainMenu(chatId) {
    const opts = {
        reply_markup: {
            keyboard: [
                [{ text: "💰 Balance" }, { text: "💸 Withdraw" }],
                [{ text: "👛 Wallet" }, { text: "📊 Stats" }],
                [{ text: "👥 Referral" }]
            ],
            resize_keyboard: true,
            is_persistent: true
        }
    };
    bot.sendMessage(chatId, "ወደ ዋናው ማውጫ ገብተዋል:", opts);
}

// --- 4. Callbacks (Inline Buttons ለ Verify እና Admin) ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const user = await User.findOne({ userId: chatId });
    const conf = await Config.findOne({ key: "main" });

    if (data === 'verify') {
        const channels = await Channel.find();
        let allJoined = true;
        
        for (let ch of channels) {
            try {
                let member = await bot.getChatMember(ch.channelId, chatId);
                if (member.status === 'left' || member.status === 'kicked') {
                    allJoined = false;
                    break;
                }
            } catch (e) {
                allJoined = false; 
            }
        }

        if (allJoined) {
            if (!user.verified) {
                user.verified = true;
                await user.save();
                
                if (user.referrer) {
                    let refUser = await User.findOne({ userId: user.referrer });
                    if (refUser) {
                        refUser.balance += conf.refReward;
                        refUser.refs += 1;
                        await refUser.save();
                        bot.sendMessage(user.referrer, `🎉 በአንተ ሊንክ አንድ ሰው ገብቶ Verify አድርጓል! ${conf.refReward} ብር ተጨምሮልሃል።`);
                    }
                }
            }
            bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
            showMainMenu(chatId);
        } else {
            bot.answerCallbackQuery(query.id, { text: "ሁሉንም ቻናሎች join አላደረጉም!", show_alert: true });
        }
        return;
    }

    // Admin Callbacks
    if (chatId !== ADMIN_ID) return;

    if (data === 'admin_broadcast') {
        userStates[chatId] = 'WAITING_BROADCAST';
        bot.sendMessage(chatId, "ለሁሉም የ ቦት ተጠቃሚዎች የሚላከውን መልዕክት ይጻፉ:");
    }
    if (data === 'admin_add_channel') {
        userStates[chatId] = 'WAITING_CHANNEL_ID';
        bot.sendMessage(chatId, "የቻናሉን ዩዘርኔም (ለምሳሌ @mychannel) ወይም ቻናል ID ያስገቡ:");
    }
    if (data === 'admin_remove_channel') {
        const channels = await Channel.find();
        if (channels.length === 0) return bot.sendMessage(chatId, "በአሁኑ ሰዓት Force join ላይ ቻናል የለም።");
        let keys = channels.map(ch => [{ text: `❌ አጥፋ: ${ch.channelId}`, callback_data: `remch_${ch._id}` }]);
        bot.sendMessage(chatId, "ከ force join ላይ ለማጥፋት የሚፈልጉትን ቻናል ይምረጡ:", { reply_markup: { inline_keyboard: keys } });
    }
    if (data.startsWith('remch_')) {
        let chId = data.split('_')[1];
        await Channel.findByIdAndDelete(chId);
        bot.sendMessage(chatId, "ቻናሉ ከ force join ላይ ተሰርዟል!");
    }
    if (data === 'admin_ref_income') {
        userStates[chatId] = 'WAITING_REF_AMOUNT';
        bot.sendMessage(chatId, "የአንድ ሰው ጋብዣ ክፍያ ስንት ብር ይሁን? (በነጥብም ይቻላል):");
    }
    if (data === 'admin_channel_post') {
        userStates[chatId] = 'WAITING_CHANNEL_POST';
        bot.sendMessage(chatId, "ወደ ቻናሎቹ የሚላከውን መልዕክት ይጻፉ:");
    }
    // አዲስ የተጨመረው Add Balance
    if (data === 'admin_add_balance') {
        userStates[chatId] = 'WAITING_USER_ID_BALANCE';
        bot.sendMessage(chatId, "የተጠቃሚውን User ID ያስገቡ:");
    }
});

// --- 5. Message Input Handler ---
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text;
    const state = userStates[chatId];
    
    const user = await User.findOne({ userId: chatId });
    const conf = await Config.findOne({ key: "main" });

    // የ Main Button መንኪያዎች
    const mainButtons = ["💰 Balance", "💸 Withdraw", "👛 Wallet", "📊 Stats", "👥 Referral"];
    
    if (mainButtons.includes(text)) {
        if (!user || !user.verified) {
            return bot.sendMessage(chatId, "እባክዎ መጀመሪያ ቻናሎቹን ይቀላቀሉና Verify ያድርጉ!");
        }

        if (text === "💰 Balance") {
            // የቴሌብር ቁጥር አብሮ እንዲታይ ተደረገ
            const walletInfo = user.wallet ? `ቴሌብር አካውንት: ${user.wallet}` : "ገና አልተመዘገበም";
            return bot.sendMessage(chatId, `የእርስዎ ባላንስ: ${user.balance} ብር\n${walletInfo}\n\nቻናላችሁን ማስገባት የምትፈልጉ አናግሩን : @Rich_ard_21`);
        }

        if (text === "👛 Wallet") {
            userStates[chatId] = 'WAITING_WALLET';
            return bot.sendMessage(chatId, "telebirr account ይጠይቃል፣ እባክዎ ያስገቡ:");
        }

        if (text === "💸 Withdraw") {
            if (!user.wallet) return bot.sendMessage(chatId, "እባክዎ መጀመሪያ Wallet (telebirr) ያስገቡ። (Wallet የሚለውን ይጫኑ)");
            if (user.balance < 50) return bot.sendMessage(chatId, "ከ 50 ብር በታች ማውጣት አይችሉም።");
            
            userStates[chatId] = 'WAITING_WITHDRAW';
            return bot.sendMessage(chatId, "ማውጣት የሚፈልጉትን የብር መጠን ያስገቡ:");
        }

        if (text === "📊 Stats") {
            const totalUsers = await User.countDocuments();
            return bot.sendPhoto(chatId, "12345.jpg", { 
                caption: `📊 ጠቅላላ ተጠቃሚዎች: ${totalUsers}\n💸 ጠቅላላ ወጪ: ${conf.totalWithdrawn} ብር` 
            });
        }

        if (text === "👥 Referral") {
            const refLink = `https://t.me/${botUsername}?start=${chatId}`;
            return bot.sendPhoto(chatId, "12345.jpg", {
                caption: `Refferal link: \n${refLink}\n\nአንድ ሰው ሲጋብዙ ${conf.refReward} ብር ባላንስ ላይ ያገኛሉ (ቻናል join ብለው verify ሲያደርጉ)።\nበእርስዎ የገቡ ጠቅላላ ሰዎች: ${user.refs}`
            });
        }
    }

    // State ሎጂኮች
    if (state === 'WAITING_WALLET') {
        user.wallet = text;
        await user.save();
        bot.sendMessage(chatId, "success");
        delete userStates[chatId];
    }
    else if (state === 'WAITING_WITHDRAW') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "እባክዎ ትክክለኛ የብር መጠን በቁጥር ያስገቡ።");
        if (amount > user.balance) return bot.sendMessage(chatId, "ባላንስዎ ላይ ያለው ብር አይበቃም።");
        
        user.balance -= amount;
        await user.save();
        conf.totalWithdrawn += amount;
        await conf.save();

        const caption = `ID: ${chatId}\n\nAccount or wallet: ${user.wallet}\n\nAmount: ${amount}\n\nሁኔታ : checking`;
        bot.sendPhoto(PROOF_CHANNEL, "12345.jpg", { caption: caption });
        bot.sendMessage(chatId, "ጥያቄዎ ወደ proof channel ተልኳል። ቦቱ እራሱ ልኮታል!");
        delete userStates[chatId];
    }
    
    // Admin Message States
    if (chatId === ADMIN_ID) {
        if (state === 'WAITING_BROADCAST') {
            const users = await User.find();
            users.forEach(u => bot.sendMessage(u.userId, text).catch(()=>{}));
            bot.sendMessage(chatId, "መልዕክቱ ለሁሉም ተጠቃሚዎች ተልኳል!");
            delete userStates[chatId];
        }
        else if (state === 'WAITING_USER_ID_BALANCE') {
            userStates[chatId] = `WAITING_AMOUNT_BALANCE_${text}`;
            bot.sendMessage(chatId, "የብር መጠኑን ያስገቡ:");
        }
        else if (state.startsWith('WAITING_AMOUNT_BALANCE_')) {
            const uId = state.split('_')[3];
            const amount = parseFloat(text);
            const targetUser = await User.findOne({ userId: uId });
            if (targetUser) {
                targetUser.balance += amount;
                await targetUser.save();
                bot.sendMessage(chatId, `ለ ${uId} ${amount} ብር ተጨምሯል።`);
                bot.sendMessage(uId, `🎉 በአድሚን የተጨመረልዎ የባላንስ መጠን: ${amount} ብር`);
            } else {
                bot.sendMessage(chatId, "ተጠቃሚው አልተገኘም!");
            }
            delete userStates[chatId];
        }
        // ... (ሌሎች admin states)
        else if (state === 'WAITING_CHANNEL_ID') {
            userStates[chatId] = `WAITING_CHANNEL_LINK_${text}`;
            bot.sendMessage(chatId, "የቻናሉን ሊንክ ያስገቡ:");
        }
        else if (state.startsWith('WAITING_CHANNEL_LINK_')) {
            const chId = state.replace('WAITING_CHANNEL_LINK_', '');
            await Channel.create({ channelId: chId, link: text });
            bot.sendMessage(chatId, "ቻናሉ save ተደርጓል!");
            delete userStates[chatId];
        }
        else if (state === 'WAITING_REF_AMOUNT') {
            const amt = parseFloat(text);
            await Config.updateOne({ key: "main" }, { refReward: amt });
            bot.sendMessage(chatId, `refferal income ወደ ${amt} ተቀይሯል።`);
            delete userStates[chatId];
        }
        else if (state === 'WAITING_CHANNEL_POST') {
            const channels = await Channel.find();
            channels.forEach(ch => bot.sendMessage(ch.channelId, text).catch(()=>{}));
            bot.sendMessage(chatId, "መልዕክቱ ለቻናሎቹ ተልኳል!");
            delete userStates[chatId];
        }
    }
});

// Admin Command
bot.onText(/\/admin/, (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📣 Broadcast", callback_data: "admin_broadcast" }],
                [{ text: "➕ add channel", callback_data: "admin_add_channel" }, { text: "➖ remove channel", callback_data: "admin_remove_channel" }],
                [{ text: "💰 Add Balance", callback_data: "admin_add_balance" }],
                [{ text: "💵 Ref Income", callback_data: "admin_ref_income" }, { text: "📝 Channel Post", callback_data: "admin_channel_post" }]
            ]
        }
    };
    bot.sendMessage(ADMIN_ID, "Admin Panel", opts);
});

// Dummy Web Server
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is successfully running and active!\n');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Bot Dummy server is listening on port ${PORT}`);
});

console.log("Bot is running and successfully started...");
