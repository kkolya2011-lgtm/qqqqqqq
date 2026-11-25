const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

const BOT_TOKEN = process.env.BOT_TOKEN || '8935072092:AAHZCPqMRF3KGL4nuHFhrZd3Uq1l-w-5PTU';
const TON_API_KEY = process.env.TON_API_KEY || 'AFJIW3WC32MIRRQAAAAOWITJSJTVK6JPRXS27ZWIINW4HZK4VT6NITKDERBW62ZZ62ZW66Y';
const WALLET = 'UQAUhd7_xqX1M8ybng3_6NEUH79tAZpHOa8Y6Agkzn9Z74U2'; 

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const db = new sqlite3.Database('./db.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, balance REAL DEFAULT 0, ref_id TEXT, ref_earned REAL DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS deposits (comment TEXT PRIMARY KEY, user_id TEXT, amount REAL, status TEXT DEFAULT 'pending')`);
});

bot.onText(/\/start(?: (.+))?/, (msg, match) => {
    const userId = String(msg.from.id);
    const ref = match[1];
    db.get("SELECT * FROM users WHERE id = ?", [userId], (err, row) => {
        if (!row) {
            db.run("INSERT INTO users (id, ref_id) VALUES (?, ?)", [userId, ref || null]);
            if (ref) bot.sendMessage(ref, `🎉 По твоей ссылке зашел новый игрок!`).catch(()=>{});
        }
    });
    bot.sendMessage(userId, "Жми кнопку ниже, чтобы играть!", {
        reply_markup: { inline_keyboard: [[{ text: "🎰 Открыть NoPlay", web_app: { url: "https://kkolya2011-lgtm.github.io/qqqqqqq/" } }]] }
    });
});

app.post('/api/login', (req, res) => {
    const { id } = req.body;
    db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => {
        if (!row) {
            db.run("INSERT INTO users (id, balance) VALUES (?, 1.0)", [id]);
            res.json({ balance: 1.0, ref_earned: 0 });
        } else {
            res.json({ balance: row.balance, ref_earned: row.ref_earned });
        }
    });
});

app.post('/api/deposit/create', (req, res) => {
    const { id, amount } = req.body;
    const comment = `dep_${id}_${Date.now()}`;
    db.run("INSERT INTO deposits (comment, user_id, amount) VALUES (?, ?, ?)", [comment, id, amount]);
    res.json({ comment, wallet: WALLET });
});

app.post('/api/deposit/check', (req, res) => {
    const { comment } = req.body;
    db.get("SELECT status FROM deposits WHERE comment = ?", [comment], (err, row) => {
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
