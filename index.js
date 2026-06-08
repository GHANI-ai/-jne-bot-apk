const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { exec } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getValidToken } = require('./audit_system/jne_auth');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

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

    if (!sock.authState.creds.registered) {
        console.log('\n[INFO] Sesi login belum ditemukan.');
        const phoneNumber = await question('Masukkan Nomor WhatsApp Bot (awali dengan 62, contoh: 62812345...): ');
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        setTimeout(async () => {
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
                console.log('Gagal meminta Pairing Code:', err);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Kita abaikan QR code karena sekarang menggunakan Pairing Code
        
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
            let statusMsg = await sock.sendMessage(chatId, { text: "⏳ *[1/3]* Membaca memori data awal JNE..." }, { quoted: msg });
            const token = await getValidToken();
            const date = new Date().toISOString().split('T')[0];
            const url = `https://sca.jne.id/lm-api/dashboard/report?from=${date}&to=${date}&result_type=list`;
            
            // 1. Tarik data awal untuk memetakan NAMA -> ID Kurir
            let response = await axios.get(url, { headers: { "Authorization": token } });
            let data = response.data.data || [];
            
            let nameToIdMap = {};
            for(let p of data) {
                if (p.MRSHEET_COURIER_ID) {
                    nameToIdMap[p.MRSHEET_COURIER_ID.toUpperCase()] = p.MRSHEET_COURIER_ID.toUpperCase();
                    if (p.MRSHEET_COURIER_NAME) {
                        nameToIdMap[p.MRSHEET_COURIER_NAME.toUpperCase()] = p.MRSHEET_COURIER_ID.toUpperCase();
                    }
                }
            }

            // Cari ID Kurir yang sebenarnya
            let actualCourierId = param ? (nameToIdMap[param] || param) : null;

            // 2. Lakukan Sinkronisasi dengan Orion menggunakan ID yang benar
            try {
                if (actualCourierId && actualCourierId !== "SEMUA") {
                    await sock.sendMessage(chatId, { text: `⏳ *[1/3]* Mensingkronkan data kurir *${actualCourierId}* dengan satelit JNE...`, edit: statusMsg.key });
                    await axios.post('https://sca.jne.id/lm-api/sync/delivery?refresh=true', 
                        { from: date, to: date, couriers: [actualCourierId] }, 
                        { headers: { "Authorization": token }, timeout: 15000 }
                    );
                } else {
                    await sock.sendMessage(chatId, { text: `⏳ *[1/3]* Mensingkronkan SELURUH kurir yang ada di memori hari ini...`, edit: statusMsg.key });
                    const allIds = Object.values(nameToIdMap).filter((v, i, a) => a.indexOf(v) === i);
                    if (allIds.length > 0) {
                        await axios.post('https://sca.jne.id/lm-api/sync/delivery?refresh=true', 
                            { from: date, to: date, couriers: allIds }, 
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
                    name: p.MRSHEET_COURIER_NAME || cid, 
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
                let replyText = `🤖 *Dashboard Kurir Hari Ini (${date})*\n\n`;
                let closingText = "";
                let onProcessText = "";

                for(let cid in couriersMap) {
                    let c = couriersMap[cid];
                    let pctSukses = c.total > 0 ? Math.round((c.delivered / c.total) * 100) : 0;
                    
                    let statStr = `👤 *${c.name}* (${cid})\n📦 Total: ${c.total} Pkt | ✅ S: ${c.delivered} | ❌ G: ${c.failed} (${pctSukses}% Sukses)\n`;
                    
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
            if (!couriersMap[actualCourierId]) {
                await sock.sendMessage(chatId, { text: `❌ Kurir *${actualCourierId}* tidak ditemukan hari ini.` });
                return;
            }
            if (belum.includes(actualCourierId)) {
                let c = couriersMap[actualCourierId];
                let pctSukses = c.total > 0 ? Math.round((c.delivered / c.total) * 100) : 0;
                
                let rejectMsg = `🛑 *AUDIT DITOLAK!*\nKurir *${c.name}* (${actualCourierId}) masih dalam status *On Process*.\n\n`;
                rejectMsg += `📦 Total Paket: ${c.total}\n`;
                rejectMsg += `✅ Sudah Sukses: ${c.delivered} (${pctSukses}%)\n`;
                rejectMsg += `❌ Sudah Gagal: ${c.failed}\n`;
                rejectMsg += `⏳ *Belum Diupdate: ${c.unprocessed}*\n\n`;
                rejectMsg += `Harap tunggu kurir menyelesaikan sisa ${c.unprocessed} paketnya sebelum diaudit.`;
                
                await sock.sendMessage(chatId, { text: rejectMsg });
                return;
            }
            
            await sock.sendMessage(chatId, { text: `🔍 *[3/3]* Membedah paket kurir *${actualCourierId}* dengan AI, mohon tunggu...`, edit: statusMsg.key });
            await new Promise(res => exec(`node auditor_utama.js ${actualCourierId} ${date}`, {cwd: path.join(__dirname, 'audit_system')}, (err) => res()));
            await sock.sendMessage(chatId, { text: `✅ Audit selesai untuk *${actualCourierId}*! Mengirimkan PDF hasil audit...`, edit: statusMsg.key });
            
            const pdfSukses = path.join(__dirname, 'audit_system', 'Laporan', date, `Audit_SUKSES_${actualCourierId}.pdf`);
            
            let dikirim = false;
            if (fs.existsSync(pdfSukses)) {
                await sock.sendMessage(chatId, { document: fs.readFileSync(pdfSukses), mimetype: 'application/pdf', fileName: `Audit_SUKSES_${param}.pdf` });
                dikirim = true;
            }
            
            if (!dikirim) {
                await sock.sendMessage(chatId, { text: `✅ LUAR BIASA! Seluruh paket SUKSES milik *${actualCourierId}* mematuhi SOP. Tidak ada PDF pelanggaran yang dicetak.` });
            }
            
        } catch (error) {
            console.error(error);
            await sock.sendMessage(chatId, { text: "❌ Terjadi kesalahan saat memproses permintaan." });
        }
    });
}

connectToWhatsApp();
