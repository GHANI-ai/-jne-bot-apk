const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const sharp = require('sharp');
require('dotenv').config();

const keys = (process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim());
async function downloadImage(url) {
    if (!url) return null;
    const res = await axios({ url, responseType: 'arraybuffer' });
    return await sharp(Buffer.from(res.data)).resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
}

async function run() {
    const ai = new GoogleGenAI({ apiKey: keys[0] });
    const f2 = await downloadImage('https://miledata.obs.ap-southeast-4.myhuaweicloud.com/00b303cc-ead4-4897-a9f6-a3712795c642.jpg');
    const f3 = await downloadImage('https://miledata.obs.ap-southeast-4.myhuaweicloud.com/37f21d03-f07c-4c0c-ba8b-a7be4ac0dcda.jpg');
    
    console.log('Images downloaded.');
    const prompt = `Tugas: Audit Kepatuhan Kurir (Paket GAGAL / Ambil Sendiri).
       Remarks (Alasan Gagal): "diambil sendiri".
       Nomor HP Penerima: "08123456789".
       
       SYARAT SAH LOLOS AUDIT (Harus penuhi SALAH SATU jalur ini):
       1. JALUR CHAT: Ada foto screenshot bukti chat. Jika remarks adalah "diambil sendiri / ambil di kantor", dan pelanggan merespon "Oke / Siap / Terima Kasih / Ya", maka itu dianggap SAH (Kesepakatan). 
       2. JALUR TELEPON: Ada foto bukti riwayat panggilan (log) telepon keluar ke nomor penerima. (Jika 4 angka belakang nomor disamarkan, tetap SAH).

       PELANGGARAN: 
       - Jika hanya foto paket tanpa screenshot chat/telepon -> Alasan: "Tidak ada bukti chat/telepon"
       - Jika ada chat tapi pelanggan tidak membalas / isinya sama sekali tidak nyambung dengan remarks -> Alasan: "Isi chat tidak membuktikan persetujuan/tidak nyambung"
       
       Penting: Balas HANYA format JSON utuh: {"valid": true/false, "alasan": "JIKA valid=true biarkan KOSONG (''). JIKA valid=false tulis SINGKAT sesuai panduan."}`;
       
    const imageParts = [];
    if(f2) imageParts.push({ inlineData: { data: f2.toString('base64'), mimeType: 'image/jpeg' }});
    if(f3) imageParts.push({ inlineData: { data: f3.toString('base64'), mimeType: 'image/jpeg' }});
    
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [prompt, ...imageParts],
        config: { responseMimeType: 'application/json' }
    });
    console.log(response.text);
}
run();
