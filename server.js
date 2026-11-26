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
const db = new sqlite3.Database('./db_final3.sqlite'); // НОВОЕ ИМЯ БАЗЫ (чтобы не было конфликтов при обновлении)

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
    let isSubscribed = true;
    for (let channel of CHANNELS) {
        try {
            const member = await bot.getChatMember(channel, id);
            if (member.status === 'left' || member.status === 'kicked') { isSubscribed = false; break; }
        } catch(e) {} 
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

// --- 1. ЛОГИКА МИН ---
app.post('/api/mines/start', (req, res) => {
    const { id, bet, mines } = req.body; 
    if (!bet || bet <= 0) return res.json({ error: 'Неверная ставка' });
    if (!mines || mines < 1 || mines > 24) return res.json({ error: 'Неверное кол-во мин' });
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        let field = new Array(25).fill(false);
        let placed = 0;
        while (placed < mines) {
            let pos = Math.floor(Math.random() * 25);
            if (!field[pos]) { field[pos] = true; placed++; }
        }
        const gameId = Date.now().toString();
        db.run("INSERT INTO active_games (id, user_id, game_type, bet, data) VALUES (?, ?, 'mines', ?, ?)", [gameId, id, bet, JSON.stringify(field)]);
        res.json({ success: true, gameId, bet });
    });
});

app.post('/api/mines/click', (req, res) => {
    const { id, gameId, cellIndex, currentMultiplier } = req.body;
    db.get("SELECT * FROM active_games WHERE id = ? AND user_id = ?", [gameId, id], (err, game) => {
        if (!game) return res.json({ error: 'Игра не найдена' });
        let field = JSON.parse(game.data);
        let isMine = field[cellIndex];
        // ПОДКРУТКА: шанс на мину вырастает, если кэшаут уже больше 1.5
        if (!isMine && currentMultiplier > 1.5 && Math.random() < 0.4) isMine = true;
        if (isMine) {
            db.run("DELETE FROM active_games WHERE id = ?", [gameId]);
            res.json({ success: false, isMine: true });
        } else {
            res.json({ success: true, isMine: false });
        }
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

// --- 2. ЛОГИКА РАКЕТКИ ---
app.post('/api/crash/start', (req, res) => {
    const { id, bet } = req.body;
    if (!bet || bet <= 0) return res.json({ error: 'Неверная ставка' });
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        let crashPoint = 1.00;
        const rand = Math.random();
        if (rand < 0.65) crashPoint = 1.01 + Math.random() * 0.8; // 65% краш на x1.01-x1.81
        else if (rand < 0.95) crashPoint = 1.8 + Math.random() * 1.5; // 30% краш на x1.8-x3.3
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
        } else {
            res.json({ success: false, error: 'Ракета уже взорвалась' });
        }
    });
});

// --- 3. ЛОГИКА АПГРЕЙДЕРА ---
app.post('/api/upgrade', (req, res) => {
    const { id, itemId, targetMultiplier } = req.body;
    db.get("SELECT * FROM inventory WHERE id = ? AND user_id = ?", [itemId, id], (err, item) => {
        if (!item) return res.json({ error: 'Предмет не найден' });
        const chance = ((1 / targetMultiplier) * 100) * 0.7; // Подкрутка -30% к шансу
        const win = Math.random() * 100 <= chance;
        db.run("DELETE FROM inventory WHERE id = ?", [itemId]);
        if (win) {
            const newValue = item.value * targetMultiplier;
            db.run("INSERT INTO inventory (user_id, name, img, value) VALUES (?, ?, ?, ?)", [id, item.name + ' (x' + targetMultiplier + ')', item.img, newValue], function() {
                res.json({ success: true, newItem: { id: this.lastID, name: item.name, img: item.img, value: newValue } });
            });
        } else {
            res.json({ success: false });
        }
    });
});

// --- 4. ЛОГИКА КОЛЕСА (РУЛЕТКИ) ---
app.post('/api/wheel/spin', (req, res) => {
    const { id, bet } = req.body;
    if (!bet || bet <= 0) return res.json({ error: 'Неверная ставка' });
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        
        // Подкрутка: визуально 8 секторов, реально выигрыш реже
        const rand = Math.random() * 100;
        let winMult = 0;
        if (rand > 90) winMult = 3;       // 10% шанс
        else if (rand > 70) winMult = 2;  // 20% шанс
        else if (rand > 40) winMult = 1.5;// 30% шанс
        else if (rand > 10) winMult = 1;  // 30% шанс (возврат)
        else winMult = 0;                 // 10% шанс (всё сгорает)

        if (winMult > 0) {
            const winAmount = bet * winMult;
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, id]);
            res.json({ success: true, winMult, win: winAmount });
        } else {
            res.json({ success: false, winMult: 0, win: 0 });
        }
    });
});

// --- 5. ЛОГИКА НАПЕРСТКОВ ---
app.post('/api/cups/play', (req, res) => {
    const { id, bet, choice } = req.body; // choice от 1 до 3
    if (!bet || bet <= 0) return res.json({ error: 'Неверная ставка' });
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        
        // Подкрутка: реальный шанс выигрыша 30% (хотя игрок думает, что 33%)
        const isWin = Math.random() < 0.3;
        const winAmount = bet * 2.5; // Выплата х2.5
        
        if (isWin) {
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, id]);
            res.json({ success: true, win: winAmount, rightChoice: choice });
        } else {
            // Если проигрыш, выбираем любой другой колпачок
            let rightChoice = choice + 1;
            if (rightChoice > 3) rightChoice = 1;
            res.json({ success: false, win: 0, rightChoice: rightChoice });
        }
    });
});

// --- 6. ЛОГИКА КРАНА ---
app.post('/api/claw/grab', (req, res) => {
    const { id, bet } = req.body;
    if (!bet || bet <= 0) return res.json({ error: 'Неверная ставка' });
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        
        // Подкрутка: 85% шанс, что кран разожмется
        const isWin = Math.random() > 0.85; 
        
        if (isWin) {
            const winAmount = bet * 2; // Выплата х2
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, id]);
            res.json({ success: true, win: winAmount });
        } else {
            res.json({ success: false, win: 0 });
        }
    });
});

// --- 7. ЛОГИКА СЛОТОВ ---
app.post('/api/slots/spin', (req, res) => {
    const { id, bet } = req.body;
    if (!bet || bet < 5) return res.json({ error: 'Мин. ставка в слотах 5 TON' }); // Порог 5 TON
    db.get("SELECT balance FROM users WHERE id = ?", [id], (err, row) => {
        if (!row || row.balance < bet) return res.json({ error: 'Недостаточно средств' });
        db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [bet, id]);
        
        // Твоя математика понижения шансов от суммы
        let winChance = 15;
        if (bet >= 15) winChance = 2;
        else if (bet >= 10) winChance = 5;
        else if (bet >= 7) winChance = 7;
        else if (bet >= 5) winChance = 10;

        const isWin = Math.random() * 100 <= winChance;
        const winAmount = bet * 5; // Выплата х5
        
        // Генерируем визуальные слоты (3 штуки)
        const symbols = ['🍒', '🍋', '💎', '⭐', '🔔'];
        let slot1 = symbols[Math.floor(Math.random() * symbols.length)];
        let slot2 = symbols[Math.floor(Math.random() * symbols.length)];
        let slot3 = symbols[Math.floor(Math.random() * symbols.length)];

        if (isWin) {
            // Делаем выигрышную комбинацию
            slot2 = slot1; slot3 = slot1;
            db.run("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, id]);
            res.json({ success: true, win: winAmount, slots: [slot1, slot2, slot3] });
        } else {
            // Делаем так, чтобы две картинки совпадали (эффект "почти выиграл")
            if (Math.random() > 0.5) slot2 = slot1;
            else slot3 = slot1;
            res.json({ success: false, win: 0, slots: [slot1, slot2, slot3] });
        }
    });
});

// --- ЗАГЛУШКИ ---
app.post('/api/promo/activate', (req, res) => res.json({ error: 'В разработке' }));
app.post('/api/spin_free', (req, res) => res.json({ success: true }));
app.post('/api/deposit/create', (req, res) => res.json({ comment: 'test', wallet: WALLET }));
app.post('/api/deposit/check', (req, res) => res.json({ status: 'pending' }));

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
