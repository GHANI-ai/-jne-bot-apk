const axios = require('axios');
const fs = require('fs');
const { getValidToken } = require('./jne_auth');
const sharp = require('sharp');
const { GoogleGenAI } = require('@google/genai');

require('dotenv').config();
const keys = (process.env.GEMINI_API_KEYS || "").split(',').map(k => k.trim());
let keyIndex = 0;
function getNextKey() {
    const key = keys[keyIndex];
    keyIndex = (keyIndex + 1) % keys.length;
    return key;
}

async function downloadImage(url) {
    if (!url) return null;
    try {
        const res = await axios({ url, responseType: 'arraybuffer', timeout: 10000 });
        const rawBuffer = Buffer.from(res.data, 'binary');
        return await sharp(rawBuffer).resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
    } catch (e) { return null; }
}

async function runAI(resi, statusType, f1, f2, f3) {
    const remarks = (resi.DRSHEET_REMARKS || '').trim().toLowerCase();
    const noHp = (resi.CNOTE_RECEIVER_PHONE || resi.RECEIVER_PHONE || resi.CNOTE_RECEIVER_CONTACT || 'tidak diketahui').trim();
    
    const prompt = statusType === 'SUKSES' 
    ? `Tugas: Audit Kepatuhan Kurir (Paket SUKSES).
       SYARAT SAH LOLOS AUDIT (Harus penuhi SALAH SATU jalur ini):
       1. JALUR NORMAL: Ada gambar orang yang menerima/mengambil barang. Syarat sah: WAJIB nampak kepala/wajah penerima dan paketnya.
       2. JALUR PIHAK KE-3: Jika tidak ada foto kepala/wajah penerima, maka WAJIB ada foto screenshot bukti chat persetujuan dengan penerima, ATAU foto pengantaran via kapal/boat.

       PELANGGARAN: Jika gambar HANYA foto paket (di lantai, meja, rumput, pagar, atau sekadar tangan memegang paket tanpa terlihat muka) DAN tidak ada bukti chat / kapal, maka itu TIDAK SAH!
       
       Penting: Balas HANYA format JSON utuh: {"valid": true/false, "alasan": "JIKA valid=true biarkan KOSONG (''). JIKA valid=false tulis pelanggarannya SINGKAT (maks 5-7 kata)."}`
       
    : `Tugas: Audit Kepatuhan Kurir (Paket GAGAL).
       Remarks (Alasan Gagal): "${remarks}".
       Nomor HP Penerima: "${noHp}".
       
       SYARAT SAH LOLOS AUDIT (Harus penuhi SALAH SATU jalur ini):
       1. JALUR CHAT: Ada foto screenshot bukti chat yang isinya SESUAI/Nyambung dengan remarks kurir, DAN ada gambar paketnya (tidak wajib nampak muka/orang).
       2. JALUR TELEPON: Ada foto bukti riwayat panggilan (log) telepon yang ditujukan ke nomor penerima. (Catatan: Jika 4 angka belakang nomor HP di foto terlihat disamarkan/terpotong, tetap anggap SAH karena itu foto telepon).

       PELANGGARAN: Jika hanya foto paket/rumah kosong tanpa ada screenshot chat/log telepon, ATAU jika bukti chat sama sekali tidak nyambung dengan remarks, maka TIDAK SAH!
       
       Penting: Balas HANYA format JSON utuh: {"valid": true/false, "alasan": "JIKA valid=true biarkan KOSONG (''). JIKA valid=false tulis SINGKAT (maks 5-7 kata)."}`;

    const ai = new GoogleGenAI({ apiKey: getNextKey() });
    const imageParts = [];
    if (f1) imageParts.push({ inlineData: { data: f1.toString("base64"), mimeType: "image/jpeg" } });
    if (f2) imageParts.push({ inlineData: { data: f2.toString("base64"), mimeType: "image/jpeg" } });
    if (f3) imageParts.push({ inlineData: { data: f3.toString("base64"), mimeType: "image/jpeg" } });

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: [prompt, ...imageParts],
            config: { responseMimeType: "application/json" }
        });
        return JSON.parse(response.text);
    } catch (e) {
        return { valid: false, alasan: e.message };
    }
}

async function run() {
    const token = await getValidToken();
    const date = '2026-06-07';
    
    console.log('🔄 Fetching reports for multiple couriers...');
    const cids = ['PKU1299', 'PKU1151', 'PKU1152', 'PKU030'];
    await axios.post('https://sca.jne.id/lm-api/sync/delivery?refresh=true', { from: date, to: date, couriers: cids }, { headers: { Authorization: token } });
    
    let resiList = [];
    for (let c of cids) {
        const urlDetail = `https://sca.jne.id/lm-api/dashboard/report?&from=${date}&to=${date}&courier_id=${c}&result_type=list`;
        try {
            const res = await axios.get(urlDetail, { headers: { Authorization: token } });
            if (res.data && res.data.data) {
                resiList.push(...res.data.data);
            }
        } catch(e) {}
    }
    
    // Filter out items with absolutely no photos
    resiList = resiList.filter(r => r.DRSHEET_PHOTO1 || r.DRSHEET_PHOTO2 || r.DRSHEET_PHOTO3);
    
    const success = resiList.filter(r => (r.DRSHEET_STATUS || '').startsWith('D')).slice(0, 5);
    const failed = resiList.filter(r => !(r.DRSHEET_STATUS || '').startsWith('D') && r.DRSHEET_STATUS !== 'CR3' && r.DRSHEET_STATUS !== '').slice(0, 5);
    
    console.log(`✅ Ditemukan ${success.length} SUKSES dan ${failed.length} GAGAL. Mulai test AI...`);
    
    const toTest = [...success.map(r => ({...r, type: 'SUKSES'})), ...failed.map(r => ({...r, type: 'GAGAL'}))];
    
    for(let r of toTest) {
        console.log(`\n📦 Resi: ${r.DRSHEET_CNOTE_NO} (${r.type}) | Remarks: ${r.DRSHEET_REMARKS || 'Tidak ada'}`);
        console.log(`⏳ Download Gambar...`);
        const f1 = await downloadImage(r.DRSHEET_PHOTO1);
        const f2 = await downloadImage(r.DRSHEET_PHOTO2);
        const f3 = await downloadImage(r.DRSHEET_PHOTO3);
        
        console.log(`🧠 AI Berpikir...`);
        const start = Date.now();
        const hasil = await runAI(r, r.type, f1, f2, f3);
        const timeMs = Date.now() - start;
        console.log(`👉 Hasil: ${hasil.valid ? '✅ LULUS' : '❌ MELANGGAR'} (${timeMs}ms)`);
        if(!hasil.valid) console.log(`👉 Alasan: ${hasil.alasan}`);
    }
}

run();
