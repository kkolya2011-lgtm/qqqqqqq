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
const CHANNELS = ['@noplayhub', '@nosaler']; 
const ADMIN_ID = 8452970548; 

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('./db_final2.sqlite'); // НОВОЕ ИМЯ БАЗЫ (чтобы не было конфликтов)

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, balance REAL DEFAULT 0, ref_id TEXT, ref_earned REAL DEFAULT 0, last_free_spin INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS deposits (comment TEXT PRIMARY KEY, user_id TEXT, amount REAL, status TEXT DEFAULT 'pending')`);
    db.run(`CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT, img TEXT, value REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS promos (code TEXT PRIMARY KEY, amount REAL, max_uses INTEGER, current_uses INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS user_promos (user_id TEXT, code TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS active_games (id TEXT PRIMARY KEY, user_id TEXT, game_type TEXT, bet REAL, data TEXT)`);
});

// --- АДМИН ПАНЕЛЬ ---
let adminState = {}; 

bot.onText(/\/admin/, (msg) => {
    if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "У вас нет доступа.");
    bot.sendMessage(msg.chat.id, "Админ-панель", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Создать промокод", callback_data: "create_promo" }],
                [{ text: "Статистика", callback_data: "stats" }]
            ]
        }
    });
});

bot.on('callback_query', (query) => {
    if (query.from.id !== ADMIN_ID) return;
    const chatId = query.message.chat.id;

    if (query.data === 'stats') {
        db.get("SELECT COUNT(*) as users, SUM(balance) as total_balance FROM users", (err, row) => {
            db.get("SELECT COUNT(*) as inv FROM inventory", (err2, row2) => {
                bot.sendMessage(chatId, `Статистика\n\nЮзеров: ${row.users}\nБаланс в системе: ${(row.total_balance || 0).toFixed(2)} TON\nПредметов в инвентарях: ${row2.inv}`);
            });
        });
        bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'create_promo') {
        adminState[chatId] = { step: 'amount' };
        bot.sendMessage(chatId, "Введи сумму промокода в TON (например: 5):");
        bot.answerCallbackQuery(query.id);
    }
});

bot.on('message', (msg) => {
    if (msg.from.id !== ADMIN_ID || !adminState[msg.chat.id]) return;
    const state = adminState[msg.chat.id];
    const chatId = msg.chat.id;
    const text = msg.text;

    if (state.step === 'amount') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "Введи число больше 0.");
        adminState[chatId] = { step: 'limit', amount };
        bot.sendMessage(chatId, "Теперь введи лимит активаций (например: 10):");
    } 
    else if (state.step === 'limit') {
        const limit = parseInt(text);
        if (isNaN(limit) || limit <= 0) return bot.sendMessage(chatId, "Введи целое число больше 0.");
        
        const code = 'PROMO-' + Math.random().toString(36).substring(2, 7).toUpperCase();
        db.run("INSERT INTO promos (code, amount, max_uses) VALUES (?, ?, ?)", [code, state.amount, limit]);
        
        bot.sendMessage(chatId, `Промокод создан!\n\nКод: ${code}\nСумма: ${state.amount} TON\nЛимит: ${limit} активаций`);
        delete adminState[chatId];
    }
});

// --- СТАРТ БОТА ---
bot.onText(/\/start(?: (.+))?/, (msg, match) => {
    const userId = String(msg.from.id);
    const ref = match[1];
    db.get("SELECT * FROM users WHERE id = ?", [userId], (err, row) => {
        if (!row) {
            db.run("INSERT OR IGNORE INTO users (id, ref_id) VALUES (?, ?)", [userId, ref || null]);
            if (ref) bot.sendMessage(ref, `По твоей ссылке зашел новый игрок!`).catch(()=>{});
        }
    });
    bot.sendMessage(userId, "Жми кнопку ниже, чтобы играть!", {
        reply_markup: { inline_keyboard: [[{ text: "Открыть nosaler", web_app: { url: "https://kkolya2011-lgtm.github.io/qqqqqqq/" } }]] }
    });
});

// --- API ДЛЯ САЙТА ---
app.post('/api/login', async (req, res) => {
    const { id } = req.body;
    
    // Проверка подписки
    let isSubscribed = true;
    for (let channel of CHANNELS) {
        try {
            const member = await bot.getChatMember(channel, id);
            if (member.status === 'left' || member.status === 'kicked') { 
                isSubscribed = false; 
                break; 
            }
        } catch(e) {
            // Если бот не админ в канале, он не сможет проверить. 
            // Чтобы не блокировать всех, оставляем true (но лучше сделай бота админом).
            console.log(`Ошибка проверки канала ${channel}:`, e.message); 
        } 
    }

    db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => {
        if (!row) {
            db.run("INSERT OR IGNORE INTO users (id) VALUES (?)", [id]);
            res.json({ balance: 0, isSubscribed, lastFreeSpin: 0, ref_earned: 0 });
        } else {
            res.json({ balance: row.balance, isSubscribed, lastFreeSpin: row.last_free_spin, ref_earned: row.ref_earned || 0 });
        }
    });
});

app.post('/api/inventory', (req, res) => {
    db.all("SELECT * FROM inventory WHERE user_id = ?", [req.body.id], (err, rows) => res.json(rows || []));
});

// --- ЛОГИКА ИГР (РАКЕТКА) ---
app.post('/api/crash/start', (req, res) => {
    const { id, bet } = req.body;
    if (!bet || bet <= 0) return res.json({ error: 'Неверная ставка' });

    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);

        let crashPoint = 1.00;
        const rand = Math.random();
        if (rand < 0.65) crashPoint = 1.01 + Math.random() * 0.8; // 65% шанс краша на низких
        else if (rand < 0.95) crashPoint = 1.8 + Math.random() * 1.5; // 30% шанс средних
        else crashPoint = 3.0 + Math.random() * 7.0; // 5% шанс высоких

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
        } else {
            res.json({ success: false, error: 'Ракета уже взорвалась' });
        }
    });
});

// --- ЗАГЛУШКИ ДЛЯ ОСТАЛЬНЫХ ФУНКЦИЙ ---
app.post('/api/promo/activate', (req, res) => res.json({ error: 'В разработке' }));
app.post('/api/spin_free', (req, res) => res.json({ success: true }));
app.post('/api/deposit/create', (req, res) => res.json({ comment: 'test', wallet: WALLET }));
app.post('/api/deposit/check', (req, res) => res.json({ status: 'pending' }));

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
