const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { exec } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getValidToken } = require('./audit_system/jne_auth');

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const DB_FILE = 'database.json';
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], locations: {} }, null, 2));
}

function loadDB() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); } catch(e) { return { users: [], locations: {} }; }
}
function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// =====================================
// SERVER MABES API ENDPOINTS
// =====================================
app.post('/api/login', (req, res) => {
    const { name, age, dob, whatsapp, password, lat, lng } = req.body;
    let db = loadDB();
    let user = db.users.find(u => u.whatsapp === whatsapp);
    if (!user) {
        user = { name, age, dob, whatsapp, password, isBanned: false };
        db.users.push(user);
    } else {
        if (user.password !== password) return res.status(401).json({ error: 'Password salah' });
        if (user.isBanned) return res.status(403).json({ error: 'Akun Anda telah di-banned.' });
    }
    if (lat && lng) db.locations[whatsapp] = { name: user.name, lat, lng, timestamp: new Date().toISOString() };
    saveDB(db);
    res.json({ success: true, message: 'Login berhasil', user });
});

app.post('/api/location', (req, res) => {
    const { whatsapp, lat, lng } = req.body;
    let db = loadDB();
    let user = db.users.find(u => u.whatsapp === whatsapp);
    if (user && !user.isBanned) {
        db.locations[whatsapp] = { name: user.name, lat, lng, timestamp: new Date().toISOString() };
        saveDB(db);
        return res.json({ success: true });
    }
    res.status(403).json({ error: 'Unauthorized or banned' });
});

app.get('/api/users', (req, res) => {
    let db = loadDB();
    res.json({ success: true, users: db.users.map(u => ({ name: u.name, whatsapp: u.whatsapp, age: u.age, isBanned: u.isBanned })) });
});

app.get('/api/notes', (req, res) => {
    let db = loadDB();
    if (!db.notes) { db.notes = []; saveDB(db); }
    res.json({ success: true, notes: db.notes });
});

app.post('/api/notes', (req, res) => {
    const { id, text, color, offsetX, offsetY } = req.body;
    let db = loadDB();
    if (!db.notes) db.notes = [];
    const idx = db.notes.findIndex(n => n.id === id);
    if (idx >= 0) { db.notes[idx].offsetX = offsetX; db.notes[idx].offsetY = offsetY; }
    else { db.notes.push({ id, text, color, offsetX, offsetY }); }
    saveDB(db);
    res.json({ success: true });
});

app.delete('/api/notes/:id', (req, res) => {
    let db = loadDB();
    if (db.notes) { db.notes = db.notes.filter(n => n.id !== parseInt(req.params.id)); saveDB(db); }
    res.json({ success: true });
});

app.post('/api/gps-status', (req, res) => {
    const { whatsapp, status } = req.body;
    if (status === false) {
        let db = loadDB();
        const user = db.users.find(u => u.whatsapp === whatsapp);
        const name = user ? user.name : "Karyawan Tak Dikenal";
        console.log(`\n🚨 ALARM PELANGGARAN! 🚨`);
        console.log(`⚠️ Pekerja: ${name} (WA: ${whatsapp})`);
        console.log(`⚠️ Status: MEMATIKAN GPS SECARA SENGAJA!`);
        console.log(`🚨 ALARM PELANGGARAN! 🚨\n`);
    }
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 MABES SERVER (API) MENYALA DI PORT ${PORT}`));

// =====================================
// FUNGSI HISTORY AUDIT (Cegah Double)
// =====================================
function markAudited(date, courierId) {
    const file = path.join(__dirname, 'audit_system', 'Laporan', `history.json`);
    let history = {};
    if (fs.existsSync(file)) {
        try { history = JSON.parse(fs.readFileSync(file)); } catch(e){}
    }
    if (!history[date]) history[date] = [];
    if (!history[date].includes(courierId)) history[date].push(courierId);
    fs.writeFileSync(file, JSON.stringify(history, null, 2));
}

function isAudited(date, courierId) {
    const file = path.join(__dirname, 'audit_system', 'Laporan', `history.json`);
    if (!fs.existsSync(file)) return false;
    try {
        let history = JSON.parse(fs.readFileSync(file));
        return history[date] && history[date].includes(courierId);
    } catch(e) { return false; }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function connectToWhatsApp() {
    console.log("Memulai Bot Audit JNE Super Ringan...");
    
    // Ambil versi WA Web terbaru agar tidak ditolak server
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Menggunakan versi WA v${version.join('.')}`);

    // Simpan sesi di folder terpisah
    const { state, saveCreds } = await useMultiFileAuthState('bot_session');

    // Minta nomor telepon SEBELUM membuka koneksi WebSocket agar event QR tidak terlewat
    let cleanNumber = "";
    if (!state.creds.registered) {
        console.log('\n[INFO] Sesi login belum ditemukan.');
        const phoneNumber = await question('Masukkan Nomor WhatsApp Bot (awali dengan 62, contoh: 62812345...): ');
        cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    }

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }), // Matikan log setelah fix
        browser: ["Ubuntu", "Chrome", "120.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Minta Pairing Code HANYA ketika socket sudah siap (ditandai dengan munculnya event QR)
        if (qr && !sock.authState.creds.registered && cleanNumber) {
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                console.log(`\n=========================================`);
                console.log(`🔐 KODE PAIRING ANDA: ${code}`);
                console.log(`=========================================`);
                console.log(`Langkah-langkah:`);
                console.log(`1. Buka aplikasi WhatsApp`);
                console.log(`2. Pilih menu "Perangkat Tertaut" (Linked Devices)`);
                console.log(`3. Pilih "Tautkan dengan Nomor Telepon"`);
                console.log(`4. Masukkan kode di atas`);
                console.log(`=========================================\n`);
            } catch (err) {
                console.log('\n❌ Gagal meminta Pairing Code. Silakan restart program.', err.message);
            }
        }
        
        // Kita abaikan QR code karena sekarang menggunakan Pairing Code
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Menghubungkan ulang...', shouldReconnect);
            
            if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                console.log('🚪 Anda telah Log Out. Menghapus sesi lama...');
                fs.rmSync('bot_session', { recursive: true, force: true });
                console.log('♻️ Memulai ulang bot untuk membuat QR Code baru...');
                process.exit(1); // Mati agar start.bat merestart ulang
            } else if (shouldReconnect) {
                console.log('⏳ Menunggu 3 detik sebelum menyambung ulang...');
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ Bot JNE Siap Menerima Perintah!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // Ambil teks pesan (mendukung pesan biasa atau extended/reply)
        const messageType = Object.keys(msg.message)[0];
        const text = msg.message.conversation || msg.message[messageType]?.text || "";
        
        // =====================================
        // AI ENGINE (Teks biasa tanpa awalan /)
        // =====================================
        if (!text.startsWith('/')) {
            const chatId = msg.key.remoteJid;
            const isGroup = chatId.endsWith('@g.us');
            const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            
            // Cek apakah disebut (mentioned) atau di-reply
            const contextInfo = msg.message[messageType]?.contextInfo;
            const isMentioned = contextInfo?.mentionedJid?.includes(botNumber);
            const isReplyToBot = contextInfo?.participant === botNumber;

            // Logika AI: Balas jika Private Chat ATAU (Di grup HANYA jika disebut/di-reply)
            if (!isGroup || isMentioned || isReplyToBot) {
                const cleanText = text.replace(/@\d+/g, '').trim();
                if (!cleanText) return;

                // 1. Kirim pesan penanda proses
                let processMsg = await sock.sendMessage(chatId, { text: "⏳ *[Mabes AI]* Sedang memikirkan jawaban..." }, { quoted: msg });

                // 2. Eksekusi perintah (menggunakan npx jika gemini-cli diinstal secara lokal, atau langsung command-nya)
                const command = `gemini --model gemini-3.0-flash "Kamu adalah Asisten AI JNE & Mabes. Jawab ini secara ringkas: ${cleanText}"`;
                
                exec(command, async (error, stdout, stderr) => {
                    if (error) {
                        // 3. Jika error (misal command gemini tidak ditemukan), laporkan ke WhatsApp
                        console.error("Gemini CLI Error:", stderr || error.message);
                        await sock.sendMessage(chatId, { 
                            text: `❌ *Gagal Memproses AI!*\n\n*Error System:*\n\`\`\`${stderr || error.message}\`\`\``, 
                            edit: processMsg.key 
                        });
                        return;
                    }
                    if (stdout) {
                        // 4. Jika sukses, edit pesan proses menjadi jawaban asli
                        await sock.sendMessage(chatId, { text: "🤖 " + stdout.trim(), edit: processMsg.key });
                    }
                });
            }
            return; // Hentikan eksekusi, karena pesan ini BUKAN perintah /
        }
        
        // =====================================
        // NATIVE COMMAND LOGIC (Misal: /cek)
        // =====================================
        if (!text.startsWith('/cek')) return;
        
        const args = text.trim().split(/\s+/).slice(1);
        const param = args[0] ? args[0].toUpperCase() : null;
        const chatId = msg.key.remoteJid;

        try {
            let statusMsg = await sock.sendMessage(chatId, { text: "⏳ *[1/3]* Membaca memori data awal JNE..." }, { quoted: msg });
            const token = await getValidToken();
            
            const now = new Date();
            const pad = n => n < 10 ? '0' + n : n;
            const dateOnly = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
            const fullDateTime = `${dateOnly} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
            
            const url = `https://sca.jne.id/lm-api/dashboard/report?from=${dateOnly}&to=${dateOnly}&result_type=list`;
            
            // 1. Tarik data awal untuk memetakan NAMA -> ID Kurir
            let response = await axios.get(url, { headers: { "Authorization": token } });
            let data = response.data.data || [];
            
            let nameToIdMap = {};
            for(let p of data) {
                if (p.MRSHEET_COURIER_ID) {
                    const cid = p.MRSHEET_COURIER_ID.toUpperCase();
                    nameToIdMap[cid] = cid;
                    const cName = p.COURIER_NAME || p.MRSHEET_COURIER_NAME || p.DRSHEET_COURIER_NAME || p.courier_name;
                    if (cName) {
                        nameToIdMap[cName.toUpperCase()] = cid;
                    }
                }
            }

            // Cari ID Kurir yang sebenarnya
            let actualCourierId = param ? (nameToIdMap[param] || param) : null;
            
            // Parsing untuk pengecualian "/cek semua not A,B"
            let actualExcludedIds = [];
            if (param === "SEMUA" && args[1] && args[1].toUpperCase() === "NOT") {
                const notString = args.slice(2).join("").toUpperCase(); // misal "PKU862,ARDIARTI"
                actualExcludedIds = notString.split(",").map(s => {
                    const cleanId = s.trim();
                    return nameToIdMap[cleanId] || cleanId;
                }).filter(s => s.length > 0);
            }

            // 2. Lakukan Sinkronisasi dengan Orion menggunakan ID yang benar
            try {
                if (actualCourierId && actualCourierId !== "SEMUA") {
                    await sock.sendMessage(chatId, { text: `⏳ *[1/3]* Mensingkronkan data kurir *${actualCourierId}* dengan satelit JNE...`, edit: statusMsg.key });
                    await axios.post('https://sca.jne.id/lm-api/sync/delivery?refresh=true', 
                        { from: fullDateTime, to: fullDateTime, couriers: [actualCourierId] }, 
                        { headers: { "Authorization": token }, timeout: 15000 }
                    );
                } else {
                    await sock.sendMessage(chatId, { text: `⏳ *[1/3]* Mensingkronkan SELURUH kurir yang ada di memori hari ini...`, edit: statusMsg.key });
                    const allIds = Object.values(nameToIdMap).filter((v, i, a) => a.indexOf(v) === i);
                    if (allIds.length > 0) {
                        await axios.post('https://sca.jne.id/lm-api/sync/delivery?refresh=true', 
                            { from: fullDateTime, to: fullDateTime, couriers: allIds }, 
                            { headers: { "Authorization": token }, timeout: 30000 }
                        );
                    }
                }
            } catch (err) {
                console.log("Sync Error:", err.message);
            }
            
            // 3. Tarik data ulang SETELAH SINKRONISASI
            await sock.sendMessage(chatId, { text: "🔍 *[2/3]* Mencari status closing kurir terbaru...", edit: statusMsg.key });
            response = await axios.get(url, { headers: { "Authorization": token } });
            data = response.data.data || [];
            
            let couriersMap = {};
            for(let p of data) {
                if (!p.MRSHEET_COURIER_ID) continue;
                const cid = p.MRSHEET_COURIER_ID;
                if (!couriersMap[cid]) couriersMap[cid] = { 
                    total: 0, 
                    status: 'Closing', 
                    name: p.COURIER_NAME || p.MRSHEET_COURIER_NAME || p.DRSHEET_COURIER_NAME || p.courier_name || cid, 
                    delivered: 0, 
                    failed: 0,
                    unprocessed: 0
                };
                
                couriersMap[cid].total++;
                if (!p.POD_STATUS || p.POD_STATUS.trim() === '') {
                    couriersMap[cid].status = 'On Process';
                    couriersMap[cid].unprocessed++;
                } else if (p.DRSHEET_STATUS && p.DRSHEET_STATUS.startsWith('D')) {
                    couriersMap[cid].delivered++;
                } else {
                    couriersMap[cid].failed++;
                }
            }
            
            let closing = [];
            let belum = [];
            for(let cid in couriersMap) {
                if(couriersMap[cid].status === 'Closing') closing.push(cid);
                else belum.push(cid);
            }
            
            // Perintah: /cek
            if (!param) {
                let replyText = `🤖 *Dashboard Kurir Hari Ini (${dateOnly})*\n\n`;
                let closingText = "";
                let onProcessText = "";

                for(let cid in couriersMap) {
                    let c = couriersMap[cid];
                    let pctSukses = c.total > 0 ? Math.round((c.delivered / c.total) * 100) : 0;
                    
                    let statStr = `👤 *${cid}* (${c.name})\n📦 Total: ${c.total} Pkt | ✅ S: ${c.delivered} | ❌ G: ${c.failed} (${pctSukses}% Sukses)\n`;
                    
                    if (c.status === 'Closing') {
                        closingText += statStr + `\n`;
                    } else {
                        onProcessText += statStr + `⏳ Sisa On Process: ${c.unprocessed} Pkt\n\n`;
                    }
                }

                replyText += `🟢 *SUDAH CLOSING (Siap Audit):*\n${closingText || 'Belum ada\n'}\n`;
                replyText += `🟡 *BELUM CLOSING (Masih Jalan):*\n${onProcessText || 'Tidak ada\n'}\n`;
                replyText += `👉 Ketik */cek nama_kurir* untuk mengaudit.\n`;
                replyText += `👉 Ketik */cek semua* untuk mengaudit seluruh akun closing.`;
                await sock.sendMessage(chatId, { text: replyText });
                return;
            }
            
            // Perintah: /cek semua
            if (param === "SEMUA") {
                if(closing.length === 0) {
                    await sock.sendMessage(chatId, { text: "❌ Belum ada akun yang closing hari ini!" });
                    return;
                }
                
                // Filter kurir yang BELUM diaudit hari ini DAN TIDAK di-exclude
                let toAudit = closing.filter(id => {
                    if (isAudited(dateOnly, id)) return false; // Ditolak karena sudah diaudit
                    if (actualExcludedIds.includes(id)) return false; // Ditolak karena masuk daftar pengecualian (NOT)
                    return true;
                });
                
                if (toAudit.length === 0) {
                    let textMsg = "✅ Seluruh akun yang closing hari ini SUDAH selesai diaudit semua! (Tidak ada proses double)";
                    if (actualExcludedIds.length > 0) textMsg += "\n*Catatan:* Beberapa kurir dilewati karena Anda memintanya.";
                    await sock.sendMessage(chatId, { text: textMsg });
                    return;
                }
                
                let skipCount = closing.length - toAudit.length;
                let skipMsg = skipCount > 0 ? ` (Melewati ${skipCount} kurir yang sudah/dilarang)` : ``;
                
                await sock.sendMessage(chatId, { text: `🚀 Memulai eksekusi massal untuk ${toAudit.length} akun${skipMsg}...`, edit: statusMsg.key });
                
                for(let i = 0; i < toAudit.length; i++) {
                    let id = toAudit[i];
                    let cName = couriersMap[id] ? couriersMap[id].name : id;
                    
                    await sock.sendMessage(chatId, { text: `🔍 *[${i+1}/${toAudit.length}]* Sedang mengaudit kurir *${id}* (${cName})...`, edit: statusMsg.key });
                    await new Promise(res => exec(`node auditor_utama.js ${id} ${dateOnly}`, {cwd: path.join(__dirname, 'audit_system')}, (err) => res()));
                    
                    markAudited(dateOnly, id); // Tandai sudah diaudit
                    
                    const pdfSukses = path.join(__dirname, 'audit_system', 'Laporan', dateOnly, `Audit_SUKSES_${id}.pdf`);
                    let dikirim = false;
                    if (fs.existsSync(pdfSukses)) {
                        await sock.sendMessage(chatId, { document: fs.readFileSync(pdfSukses), mimetype: 'application/pdf', fileName: `Audit_SUKSES_${id}.pdf` });
                        dikirim = true;
                    }
                    if (!dikirim) {
                        await sock.sendMessage(chatId, { text: `✅ Audit *${id}* (${cName}) Selesai! (Bersih dari pelanggaran)` });
                    }
                }
                await sock.sendMessage(chatId, { text: `🎉 SEMUA AUDIT SELESAI DILAKSANAKAN!`, edit: statusMsg.key });
                return;
            }
            
            // Perintah: /cek ID
            if (!couriersMap[actualCourierId]) {
                await sock.sendMessage(chatId, { text: `❌ Kurir *${actualCourierId}* tidak ditemukan hari ini.` });
                return;
            }
            if (belum.includes(actualCourierId)) {
                let c = couriersMap[actualCourierId];
                let pctSukses = c.total > 0 ? Math.round((c.delivered / c.total) * 100) : 0;
                
                let rejectMsg = `🛑 *AUDIT DITOLAK!*\nKurir *${actualCourierId}* (${c.name}) masih dalam status *On Process*.\n\n`;
                rejectMsg += `📦 Total Paket: ${c.total}\n`;
                rejectMsg += `✅ Sudah Sukses: ${c.delivered} (${pctSukses}%)\n`;
                rejectMsg += `❌ Sudah Gagal: ${c.failed}\n`;
                rejectMsg += `⏳ *Belum Diupdate: ${c.unprocessed}*\n\n`;
                rejectMsg += `Harap tunggu kurir menyelesaikan sisa ${c.unprocessed} paketnya sebelum diaudit.`;
                
                await sock.sendMessage(chatId, { text: rejectMsg });
                return;
            }
            
            let targetName = couriersMap[actualCourierId] ? couriersMap[actualCourierId].name : actualCourierId;
            await sock.sendMessage(chatId, { text: `🔍 *[3/3]* Membedah paket kurir *${actualCourierId}* (${targetName}) dengan AI, mohon tunggu...`, edit: statusMsg.key });
            await new Promise(res => exec(`node auditor_utama.js ${actualCourierId} ${dateOnly}`, {cwd: path.join(__dirname, 'audit_system')}, (err) => res()));
            
            markAudited(dateOnly, actualCourierId); // Tandai sudah diaudit meskipun lewat manual
            
            await sock.sendMessage(chatId, { text: `✅ Audit selesai untuk *${actualCourierId}* (${targetName})! Mengirimkan PDF hasil audit...`, edit: statusMsg.key });
            
            const pdfSukses = path.join(__dirname, 'audit_system', 'Laporan', dateOnly, `Audit_SUKSES_${actualCourierId}.pdf`);
            
            let dikirim = false;
            if (fs.existsSync(pdfSukses)) {
                await sock.sendMessage(chatId, { document: fs.readFileSync(pdfSukses), mimetype: 'application/pdf', fileName: `Audit_SUKSES_${actualCourierId}.pdf` });
                dikirim = true;
            }
            
            if (!dikirim) {
                await sock.sendMessage(chatId, { text: `✅ LUAR BIASA! Seluruh paket SUKSES milik *${actualCourierId}* (${targetName}) mematuhi SOP. Tidak ada PDF pelanggaran yang dicetak.` });
            }
            
        } catch (error) {
            console.error("ERROR TERDETEKSI:", error?.message || error);
            try {
                // Jangan paksa kirim pesan jika error karena koneksi terputus (428 Precondition Required)
                const isConnectionError = error?.message?.includes('Connection Closed') || error?.output?.statusCode === 428;
                if (!isConnectionError) {
                    await sock.sendMessage(chatId, { text: "❌ Terjadi kesalahan saat memproses permintaan." });
                } else {
                    console.log("Mengabaikan pengiriman pesan error karena koneksi WhatsApp sedang terputus/reconnecting.");
                }
            } catch (fallbackError) {
                console.error("Gagal mengirim pesan peringatan (Socket mati):", fallbackError?.message);
            }
        }
    });
}

connectToWhatsApp();
