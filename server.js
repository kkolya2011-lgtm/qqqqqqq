const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const app = express();

app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '8935072092:AAHZCPqMRF3KGL4nuHFhrZd3Uq1l-w-5PTU';
const TON_API_KEY = process.env.TON_API_KEY || 'AFJIW3WC32MIRRQAAAAOWITJSJTVK6JPRXS27ZWIINW4HZK4VT6NITKDERBW62ZZ62ZW66Y';
const WALLET = 'UQAUhd7_xqX1M8ybng3_6NEUH79tAZpHOa8Y6Agkzn9Z74U2'; 
const CHANNELS = ['@noplayhub', '@nosalerchat']; 
const ADMIN_ID = 8452970548; 

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('./db_v7.sqlite'); // НОВАЯ БАЗА

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, balance REAL DEFAULT 0, ref_id TEXT, ref_earned REAL DEFAULT 0, last_free_spin INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS deposits (comment TEXT PRIMARY KEY, user_id TEXT, amount REAL, status TEXT DEFAULT 'pending')`);
    db.run(`CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT, img TEXT, value REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS promos (code TEXT PRIMARY KEY, amount REAL, max_uses INTEGER, current_uses INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS user_promos (user_id TEXT, code TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS active_games (id TEXT PRIMARY KEY, user_id TEXT, game_type TEXT, bet REAL, data TEXT)`);
});

// --- АДМИНКА ---
let adminState = {}; 
bot.onText(/\/admin/, (msg) => {
    if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "Нет доступа.");
    bot.sendMessage(msg.chat.id, "Админ-панель", { reply_markup: { inline_keyboard: [[{ text: "Создать промокод", callback_data: "create_promo" }], [{ text: "Статистика", callback_data: "stats" }]] } });
});
bot.on('callback_query', (query) => {
    if (query.from.id !== ADMIN_ID) return;
    const chatId = query.message.chat.id;
    if (query.data === 'stats') {
        db.get("SELECT COUNT(*) as users, SUM(balance) as total_balance FROM users", (err, row) => {
            db.get("SELECT COUNT(*) as inv FROM inventory", (err2, row2) => {
                bot.sendMessage(chatId, `Юзеров: ${row.users}\nБаланс: ${(row.total_balance || 0).toFixed(2)} TON\nПредметов: ${row2.inv}`);
            });
        });
        bot.answerCallbackQuery(query.id);
    }
    if (query.data === 'create_promo') {
        adminState[chatId] = { step: 'amount' };
        bot.sendMessage(chatId, "Введи сумму промокода в TON:");
        bot.answerCallbackQuery(query.id);
    }
});
bot.on('message', (msg) => {
    if (msg.from.id !== ADMIN_ID || !adminState[msg.chat.id]) return;
    const state = adminState[msg.chat.id];
    const chatId = msg.chat.id;
    if (state.step === 'amount') {
        const amount = parseFloat(msg.text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "Введи число > 0.");
        adminState[chatId] = { step: 'limit', amount };
        bot.sendMessage(chatId, "Введи лимит активаций:");
    } else if (state.step === 'limit') {
        const limit = parseInt(msg.text);
        if (isNaN(limit) || limit <= 0) return bot.sendMessage(chatId, "Введи число > 0.");
        const code = 'PROMO-' + Math.random().toString(36).substring(2, 7).toUpperCase();
        db.run("INSERT INTO promos (code, amount, max_uses) VALUES (?, ?, ?)", [code, state.amount, limit]);
        bot.sendMessage(chatId, `Промокод: ${code}\nСумма: ${state.amount} TON\nЛимит: ${limit}`);
        delete adminState[chatId];
    }
});

// --- СТАРТ ---
bot.onText(/\/start(?: (.+))?/, (msg, match) => {
    const userId = String(msg.from.id);
    const ref = match[1];
    db.get("SELECT * FROM users WHERE id = ?", [userId], (err, row) => {
        if (!row) {
            db.run("INSERT OR IGNORE INTO users (id, ref_id) VALUES (?, ?)", [userId, ref || null]);
            if (ref) bot.sendMessage(ref, `По твоей ссылке зашел новый игрок!`).catch(()=>{});
        }
    });
    bot.sendMessage(userId, "Жми кнопку ниже!", { reply_markup: { inline_keyboard: [[{ text: "Открыть nosaler", web_app: { url: "https://kkolya2011-lgtm.github.io/qqqqqqq/" } }]] } });
});

// --- API ---
app.post('/api/login', async (req, res) => {
    const { id } = req.body;
    let isSubscribed = true;
    for (let channel of CHANNELS) {
        try {
            const member = await bot.getChatMember(channel, id);
            if (member.status === 'left' || member.status === 'kicked') { isSubscribed = false; break; }
        } catch(e) {} 
    }
    db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => {
        if (!row) { db.run("INSERT OR IGNORE INTO users (id) VALUES (?)", [id]); res.json({ balance: 0, isSubscribed, ref_earned: 0 }); }
        else { res.json({ balance: row.balance, isSubscribed, ref_earned: row.ref_earned || 0 }); }
    });
});

app.post('/api/inventory', (req, res) => { db.all("SELECT * FROM inventory WHERE user_id = ?", [req.body.id], (err, rows) => res.json(rows || [])); });

app.post('/api/promo/activate', (req, res) => {
    const { id, code } = req.body;
    const upperCode = code.trim().toUpperCase();
    db.get("SELECT * FROM promos WHERE code = ?", [upperCode], (err, promo) => {
        if (!promo) return res.json({ error: 'Промокод не существует' });
        if (promo.current_uses >= promo.max_uses) return res.json({ error: 'Лимит исчерпан' });
        db.get("SELECT * FROM user_promos WHERE user_id = ? AND code = ?", [id, upperCode], (err, used) => {
            if (used) return res.json({ error: 'Уже активирован' });
            db.run("UPDATE promos SET current_uses = current_uses + 1 WHERE code = ?", [upperCode]);
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [promo.amount, id]);
            db.run("INSERT INTO user_promos (user_id, code) VALUES (?, ?)", [id, upperCode]);
            res.json({ success: true, amount: promo.amount });
        });
    });
});

// --- КЕЙСЫ ---
const giftsDB = {
    free: [
        { name: '0.01 TON', img: 'https://s6.iimage.su/s/26/gXFGm2lxPtthQRd6mrbESJy1ymjYjeMKQqYzE8gfe.jpg', value: 0.01, weight: 60 },
        { name: '0.04 TON', img: 'https://s6.iimage.su/s/26/gXFGm2lxPtthQRd6mrbESJy1ymjYjeMKQqYzE8gfe.jpg', value: 0.04, weight: 20 },
        { name: '0.1 TON', img: 'https://s6.iimage.su/s/26/gXFGm2lxPtthQRd6mrbESJy1ymjYjeMKQqYzE8gfe.jpg', value: 0.1, weight: 10 },
        { name: 'Мишка', img: 'https://i.ibb.co/HLwPtyTV/Telegram.png', value: 0.5, weight: 5 },
        { name: 'Сердечко', img: 'https://s6.iimage.su/s/26/g4ef9m9xzFMsk0SNJwmATk8FfKfQ0wDzjGvbIp16d.webp', value: 0.3, weight: 5 }
    ],
    case1: [
        { name: 'Сердечко', img: 'https://s6.iimage.su/s/26/g4ef9m9xzFMsk0SNJwmATk8FfKfQ0wDzjGvbIp16d.webp', value: 0.3, weight: 30 },
        { name: 'Мишка', img: 'https://i.ibb.co/HLwPtyTV/Telegram.png', value: 0.5, weight: 30 },
        { name: '0.25 TON', img: 'https://s6.iimage.su/s/26/gXFGm2lxPtthQRd6mrbESJy1ymjYjeMKQqYzE8gfe.jpg', value: 0.25, weight: 15 },
        { name: '0.5 TON', img: 'https://s6.iimage.su/s/26/gXFGm2lxPtthQRd6mrbESJy1ymjYjeMKQqYzE8gfe.jpg', value: 0.5, weight: 10 },
        { name: 'Diamond Ring', img: 'https://telegifter.ru/wp-content/themes/gifts/assets/img/gifts/noupdate/Diamond%20Ring.webp', value: 5.0, weight: 0.1 },
        { name: 'Genie Lamp', img: 'https://telegifter.ru/wp-content/themes/gifts/assets/img/gifts/noupdate/Genie%20Lamp.webp', value: 10.0, weight: 0.05 }
    ],
    case10: [
        { name: 'Toy Bear', img: 'https://telegifter.ru/wp-content/themes/gifts/assets/img/gifts/noupdate/Toy%20Bear.webp', value: 2.0, weight: 20 },
        { name: 'Lol Pop', img: 'https://telegifter.ru/wp-content/themes/gifts/assets/img/gifts/noupdate/Lol%20Pop.webp', value: 3.0, weight: 20 },
        { name: 'Easter Egg', img: 'https://telegifter.ru/wp-content/themes/gifts/assets/img/gifts/noupdate/Easter%20Egg.webp', value: 3.5, weight: 20 },
        { name: 'Lunar Snake', img: 'https://telegifter.ru/wp-content/themes/gifts/assets/img/gifts/noupdate/Lunar%20Snake.webp', value: 4.0, weight: 15 },
        { name: 'Top Hat', img: 'https://telegifter.ru/wp-content/themes/gifts/assets/img/gifts/noupdate/Top%20Hat.webp', value: 5.0, weight: 10 },
        { name: 'Scared Cat', img: 'https://telegifter.ru/wp-content/themes/gifts/assets/img/gifts/noupdate/Scared%20Cat.webp', value: 15.0, weight: 0.1 },
        { name: 'Astral Shard', img: 'https://telegifter.ru/wp-content/themes/gifts/assets/img/gifts/noupdate/Astral%20Shard.webp', value: 20.0, weight: 0.05 }
    ]
};

function pickGift(caseId) {
    let gifts = giftsDB[caseId];
    let total = gifts.reduce((s, g) => s + g.weight, 0);
    let r = Math.random() * total;
    for (let g of gifts) { if (r < g.weight) return g; r -= g.weight; }
    return gifts[0];
}

app.post('/api/case/open', (req, res) => {
    const { id, caseType, price } = req.body;
    if (price > 0) {
        db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
            if (!row || row.balance < price) return res.json({ error: 'Мало средств' });
            db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [price, id]);
            const gift = pickGift(caseType);
            if (gift.name.includes('TON')) {
                db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [gift.value, id]);
                res.json({ success: true, gift, addedToBal: true });
            } else {
                db.run("INSERT INTO inventory (user_id, name, img, value) VALUES (?, ?, ?, ?)", [id, gift.name, gift.img, gift.value]);
                res.json({ success: true, gift, addedToBal: false });
            }
        });
    } else {
        const gift = pickGift(caseType);
        if (gift.name.includes('TON')) {
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [gift.value, id]);
            res.json({ success: true, gift, addedToBal: true });
        } else {
            db.run("INSERT INTO inventory (user_id, name, img, value) VALUES (?, ?, ?, ?)", [id, gift.name, gift.img, gift.value]);
            res.json({ success: true, gift, addedToBal: false });
        }
    }
});

// --- 1. ЛОГИКА МИН ---
app.post('/api/mines/start', (req, res) => {
    const { id, bet, mines } = req.body; 
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        let field = new Array(25).fill(false);
        let placed = 0;
        while (placed < mines) { let pos = Math.floor(Math.random() * 25); if (!field[pos]) { field[pos] = true; placed++; } }
        const gameId = Date.now().toString();
        db.run("INSERT INTO active_games (id, user_id, game_type, bet, data) VALUES (?, ?, 'mines', ?, ?)", [gameId, id, bet, JSON.stringify(field)]);
        res.json({ success: true, gameId, bet });
    });
});
app.post('/api/mines/click', (req, res) => {
    const { id, gameId, cellIndex, currentMultiplier } = req.body;
    db.get("SELECT * FROM active_games WHERE id = ? AND user_id = ?", [gameId, id], (err, game) => {
        if (!game) return res.json({ error: 'Игра не найдена' });
        let field = JSON.parse(game.data); let isMine = field[cellIndex];
        if (!isMine && currentMultiplier > 1.5 && Math.random() < 0.4) isMine = true;
        if (isMine) { db.run("DELETE FROM active_games WHERE id = ?", [gameId]); res.json({ success: false, isMine: true }); }
        else { res.json({ success: true, isMine: false }); }
    });
});
app.post('/api/mines/cashout', (req, res) => {
    const { id, gameId, winAmount } = req.body;
    db.get("SELECT * FROM active_games WHERE id = ? AND user_id = ?", [gameId, id], (err, game) => {
        if (!game) return res.json({ error: 'Игра не найдена' });
        db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, id]);
        db.run("DELETE FROM active_games WHERE id = ?", [gameId]);
        res.json({ success: true, win: winAmount });
    });
});

// --- 2. ЛОГИКА РАКЕТКИ (ИЗМЕНЕНО ДО 1.30 - 1.40) ---
app.post('/api/crash/start', (req, res) => {
    const { id, bet } = req.body;
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        let crashPoint = 1.00;
        const rand = Math.random();
        if (rand < 0.85) crashPoint = 1.30 + Math.random() * 0.10; // 85% шанс на краш в 1.30-1.40
        else if (rand < 0.95) crashPoint = 1.4 + Math.random() * 1.5; // 10% шанс до 2.9
        else crashPoint = 3.0 + Math.random() * 7.0; // 5% шанс на высокий полет
        const gameId = Date.now().toString();
        db.run("INSERT INTO active_games (id, user_id, game_type, bet, data) VALUES (?, ?, 'crash', ?, ?)", [gameId, id, bet, crashPoint.toString()]);
        res.json({ success: true, gameId, crashPoint: parseFloat(crashPoint.toFixed(2)) });
    });
});
app.post('/api/crash/cashout', (req, res) => {
    const { id, gameId, multiplier, bet } = req.body;
    db.get("SELECT * FROM active_games WHERE id = ? AND user_id = ?", [gameId, id], (err, game) => {
        if (!game) return res.json({ error: 'Игра не найдена' });
        const winAmount = bet * multiplier;
        if (multiplier <= parseFloat(game.data)) {
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, id]);
            db.run("DELETE FROM active_games WHERE id = ?", [gameId]);
            res.json({ success: true, win: winAmount });
        } else { res.json({ success: false, error: 'Ракета уже взорвалась' }); }
    });
});

// --- 3. ЛОГИКА АПГРЕЙДЕРА ---
app.post('/api/upgrade', (req, res) => {
    const { id, itemId, targetMultiplier } = req.body;
    db.get("SELECT * FROM inventory WHERE id = ? AND user_id = ?", [itemId, id], (err, item) => {
        if (!item) return res.json({ error: 'Предмет не найден' });
        const chance = ((1 / targetMultiplier) * 100) * 0.7;
        const win = Math.random() * 100 <= chance;
        db.run("DELETE FROM inventory WHERE id = ?", [itemId]);
        if (win) {
            const newValue = item.value * targetMultiplier;
            db.run("INSERT INTO inventory (user_id, name, img, value) VALUES (?, ?, ?, ?)", [id, item.name + ' (x' + targetMultiplier + ')', item.img, newValue], function() {
                res.json({ success: true, newItem: { id: this.lastID, name: item.name, img: item.img, value: newValue } });
            });
        } else { res.json({ success: false }); }
    });
});

// --- 4. ЛОГИКА КОЛЕСА ---
app.post('/api/wheel/spin', (req, res) => {
    const { id, bet } = req.body;
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        const rand = Math.random() * 100;
        let winMult = 0;
        if (rand > 90) winMult = 3;
        else if (rand > 70) winMult = 2;
        else if (rand > 40) winMult = 1.5;
        else if (rand > 10) winMult = 1;
        else winMult = 0;
        if (winMult > 0) {
            const winAmount = bet * winMult;
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, id]);
                 db.run("DELETE FROM active_games WHERE id = ?", [gameId]);
            res.json({ success: true, win: winAmount });
        } else { res.json({ success: false, error: 'Ракета уже взорвалась' }); }
    });
});

// --- 3. ЛОГИКА АПГРЕЙДЕРА ---
app.post('/api/upgrade', (req, res) => {
    const { id, itemId, targetMultiplier } = req.body;
    db.get("SELECT * FROM inventory WHERE id = ? AND user_id = ?", [itemId, id], (err, item) => {
        if (!item) return res.json({ error: 'Предмет не найден' });
        const chance = ((1 / targetMultiplier) * 100) * 0.7;
        const win = Math.random() * 100 <= chance;
        db.run("DELETE FROM inventory WHERE id = ?", [itemId]);
        if (win) {
            const newValue = item.value * targetMultiplier;
            db.run("INSERT INTO inventory (user_id, name, img, value) VALUES (?, ?, ?, ?)", [id, item.name + ' (x' + targetMultiplier + ')', item.img, newValue], function() {
                res.json({ success: true, newItem: { id: this.lastID, name: item.name, img: item.img, value: newValue } });
            });
        } else { res.json({ success: false }); }
    });
});

// --- 4. ЛОГИКА КОЛЕСА ---
app.post('/api/wheel/spin', (req, res) => {
    const { id, bet } = req.body;
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        const rand = Math.random() * 100;
        let winMult = 0;
        if (rand > 90) winMult = 3;
        else if (rand > 70) winMult = 2;
        else if (rand > 40) winMult = 1.5;
        else if (rand > 10) winMult = 1;
        else winMult = 0;
        if (winMult > 0) {
            const winAmount = bet * winMult;
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, id]);
            res.json({ success: true, winMult, win: winAmount });
        } else { res.json({ success: false, winMult: 0, win: 0 }); }
    });
});

// --- 5. ЛОГИКА НАПЕРСТКОВ ---
app.post('/api/cups/play', (req, res) => {
    const { id, bet, choice } = req.body;
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        const isWin = Math.random() < 0.3;
        const winAmount = bet * 2.5;
        if (isWin) {
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, id]);
            res.json({ success: true, win: winAmount, rightChoice: choice });
        } else {
            let rightChoice = choice + 1; if (rightChoice > 3) rightChoice = 1;
            res.json({ success: false, win: 0, rightChoice: rightChoice });
        }
    });
});

// --- 6. ЛОГИКА КРАНА ---
app.post('/api/claw/grab', (req, res) => {
    const { id, bet } = req.body;
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        const isWin = Math.random() > 0.85; 
        if (isWin) {
            const winAmount = bet * 2;
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, id]);
            res.json({ success: true, win: winAmount });
        } else { res.json({ success: false, win: 0 }); }
    });
});

// --- ПЛАТЕЖКА TON ---
app.post('/api/deposit/create', (req, res) => {
    const { id, amount } = req.body;
    const comment = `dep_${id}_${Date.now()}`;
    db.run("INSERT INTO deposits (comment, user_id, amount) VALUES (?, ?, ?)", [comment, id, amount]);
    res.json({ comment, wallet: WALLET });
});

app.post('/api/deposit/check', (req, res) => {
    db.get("SELECT status FROM deposits WHERE comment = ?", [req.body.comment], (err, row) => {
        res.json({ status: row ? row.status : 'pending' });
    });
});

setInterval(() => {
    const options = { hostname: 'toncenter.com', path: `/api/v2/getTransactions?address=${WALLET}&limit=10`, headers: { 'X-API-Key': TON_API_KEY } };
    https.get(options, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
            try {
                const txs = JSON.parse(data).result || [];
                txs.forEach(tx => {
                    if (tx.in_msg && tx.in_msg.message) {
                        const comment = tx.in_msg.message;
                        db.get("SELECT * FROM deposits WHERE comment = ? AND status = 'pending'", [comment], (err, row) => {
                            if (row) {
                                db.run("UPDATE deposits SET status = 'paid' WHERE comment = ?", [comment]);
                                db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [row.amount, row.user_id]);
                                db.get("SELECT ref_id FROM users WHERE id = ?", [row.user_id], (e, u) => {
                                    if (u && u.ref_id) {
                                        db.run("UPDATE users SET balance = balance + ?, ref_earned = ref_earned + ? WHERE id = ?", [row.amount*0.1, row.amount*0.1, u.ref_id]);
                                    }
                                });
                            }
                        });
                    }
                });
            } catch(e) {}
        });
    });
}, 15000);

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
