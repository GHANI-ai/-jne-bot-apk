const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { exec } = require('child_process');
const rn_bridge = require('rn-bridge');

// Tangkap semua console.log agar tampil di layar HP
const originalLog = console.log;
console.log = function(...args) {
    originalLog(...args);
    if (rn_bridge && rn_bridge.channel) {
        rn_bridge.channel.post(JSON.stringify({ type: 'log', data: args.join(' ') }));
    }
}
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getValidToken } = require('./audit_system/jne_auth');

async function connectToWhatsApp() {
    console.log("Memulai Bot Audit JNE Super Ringan...");
    
    // Ambil versi WA Web terbaru agar tidak ditolak server
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Menggunakan versi WA v${version.join('.')}`);

    // Simpan sesi di folder terpisah
    const { state, saveCreds } = await useMultiFileAuthState('bot_session');

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

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n[!] SCAN QR CODE DI BAWAH INI MENGGUNAKAN WHATSAPP HP ANDA:\n');
            qrcode.generate(qr, { small: true });
            if (rn_bridge && rn_bridge.channel) {
                rn_bridge.channel.post(JSON.stringify({ type: 'qr', data: qr }));
            }
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log('Koneksi terputus. Menyambung ulang:', shouldReconnect);
            
            if (statusCode === DisconnectReason.loggedOut) {
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
            if (rn_bridge && rn_bridge.channel) {
                rn_bridge.channel.post(JSON.stringify({ type: 'status', data: 'connected' }));
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // Ambil teks pesan (mendukung pesan biasa atau extended/reply)
        const messageType = Object.keys(msg.message)[0];
        const text = msg.message.conversation || msg.message[messageType]?.text || "";
        
        if (!text.startsWith('/cek')) return;
        
        const args = text.trim().split(/\s+/).slice(1);
        const param = args[0] ? args[0].toUpperCase() : null;
        const chatId = msg.key.remoteJid;

        try {
            let statusMsg = await sock.sendMessage(chatId, { text: "⏳ *[1/3]* Mensingkronkan data dengan satelit JNE..." }, { quoted: msg });
            const token = await getValidToken();
            const date = new Date().toISOString().split('T')[0];
            
            // 0. Lakukan Sinkronisasi dengan Orion terlebih dahulu
            try {
                if (param && param !== "SEMUA") {
                    await axios.post('https://sca.jne.id/lm-api/sync/delivery?refresh=true', 
                        { from: date, to: date, couriers: [param] }, 
                        { headers: { "Authorization": token }, timeout: 15000 }
                    );
                } else {
                    await axios.post('https://sca.jne.id/lm-api/sync/delivery/level', 
                        { from: date, to: date, zone: 'PKU030' }, 
                        { headers: { "Authorization": token }, timeout: 15000 }
                    );
                }
            } catch (err) {
                console.log("Sync Error:", err.message);
                await sock.sendMessage(chatId, { text: "⚠️ Sinkronisasi lambat, menggunakan data cache terakhir.", edit: statusMsg.key });
            }
            
            await sock.sendMessage(chatId, { text: "🔍 *[2/3]* Mencari status closing kurir hari ini...", edit: statusMsg.key });
            
            // Tarik data summary
            const url = `https://sca.jne.id/lm-api/dashboard/report?from=${date}&to=${date}&result_type=list`;
            const response = await axios.get(url, { headers: { "Authorization": token } });
            const data = response.data.data || [];
            
            let couriersMap = {};
            for(let p of data) {
                if (!p.MRSHEET_COURIER_ID) continue;
                const cid = p.MRSHEET_COURIER_ID;
                if (!couriersMap[cid]) couriersMap[cid] = { total: 0, status: 'Closing' };
                couriersMap[cid].total++;
                if (!p.POD_STATUS || p.POD_STATUS.trim() === '') {
                    couriersMap[cid].status = 'On Process';
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
                let replyText = `🤖 *Status Kurir Hari Ini (${date})*\n\n`;
                replyText += `✅ *SUDAH Closing:*\n${closing.length > 0 ? closing.join(', ') : 'Belum ada'}\n\n`;
                replyText += `⏳ *BELUM Closing (On Process):*\n${belum.length > 0 ? belum.join(', ') : 'Tidak ada'}\n\n`;
                replyText += `👉 Ketik */cek <id_kurir>* untuk audit.\n`;
                replyText += `👉 Ketik */cek semua* untuk audit seluruh akun closing.`;
                await sock.sendMessage(chatId, { text: replyText });
                return;
            }
            
            // Perintah: /cek semua
            if (param === "SEMUA") {
                if(closing.length === 0) {
                    await sock.sendMessage(chatId, { text: "❌ Belum ada akun yang closing hari ini!" });
                    return;
                }
                await sock.sendMessage(chatId, { text: `🚀 Memulai eksekusi massal untuk ${closing.length} akun...`, edit: statusMsg.key });
                
                for(let i = 0; i < closing.length; i++) {
                    let id = closing[i];
                    await sock.sendMessage(chatId, { text: `🔍 *[${i+1}/${closing.length}]* Sedang mengaudit kurir *${id}*...`, edit: statusMsg.key });
                    await new Promise(res => exec(`node auditor_utama.js ${id} ${date}`, {cwd: path.join(__dirname, 'audit_system')}, (err) => res()));
                    
                    const pdfSukses = path.join(__dirname, 'audit_system', 'Laporan', date, `Audit_SUKSES_${id}.pdf`);
                    let dikirim = false;
                    if (fs.existsSync(pdfSukses)) {
                        await sock.sendMessage(chatId, { document: fs.readFileSync(pdfSukses), mimetype: 'application/pdf', fileName: `Audit_SUKSES_${id}.pdf` });
                        dikirim = true;
                    }
                    if (!dikirim) {
                        await sock.sendMessage(chatId, { text: `✅ Audit *${id}* Selesai! (Tidak ada pelanggaran / Bersih)` });
                    }
                }
                await sock.sendMessage(chatId, { text: `🎉 SEMUA AUDIT SELESAI DILAKSANAKAN!`, edit: statusMsg.key });
                return;
            }
            
            // Perintah: /cek ID
            if (!couriersMap[param]) {
                await sock.sendMessage(chatId, { text: `❌ Kurir *${param}* tidak ditemukan hari ini.` });
                return;
            }
            if (belum.includes(param)) {
                await sock.sendMessage(chatId, { text: `🛑 *DITOLAK!*\nKurir *${param}* masih *On Process*. Tunggu sampai Closing.` });
                return;
            }
            
            await sock.sendMessage(chatId, { text: `🔍 *[3/3]* Membedah paket kurir *${param}* dengan AI, mohon tunggu...`, edit: statusMsg.key });
            await new Promise(res => exec(`node auditor_utama.js ${param} ${date}`, {cwd: path.join(__dirname, 'audit_system')}, (err) => res()));
            await sock.sendMessage(chatId, { text: `✅ Audit selesai untuk *${param}*! Mengirimkan PDF hasil audit...`, edit: statusMsg.key });
            
            const pdfSukses = path.join(__dirname, 'audit_system', 'Laporan', date, `Audit_SUKSES_${param}.pdf`);
            
            let dikirim = false;
            if (fs.existsSync(pdfSukses)) {
                await sock.sendMessage(chatId, { document: fs.readFileSync(pdfSukses), mimetype: 'application/pdf', fileName: `Audit_SUKSES_${param}.pdf` });
                dikirim = true;
            }
            
            if (!dikirim) {
                await sock.sendMessage(chatId, { text: `✅ LUAR BIASA! Seluruh paket SUKSES milik *${param}* mematuhi SOP. Tidak ada PDF pelanggaran yang dicetak.` });
            }
            
        } catch (error) {
            console.error(error);
            await sock.sendMessage(chatId, { text: "❌ Terjadi kesalahan saat memproses permintaan." });
        }
    });
}

connectToWhatsApp();
