const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');

async function test() {
    const ai = new GoogleGenAI({apiKey: 'AIzaSyBKfa7wiWaBN2EDdvNjglVCYC-m9G7YEjY'});
    const p1 = await axios({url:'https://miledata.obs.ap-southeast-4.myhuaweicloud.com/f496e2a4-6908-4e89-bc5a-e51334766ef7.jpg', responseType:'arraybuffer'});
    const p2 = await axios({url:'https://miledata.obs.ap-southeast-4.myhuaweicloud.com/89021876-f680-42a5-87aa-b7c715b60081.jpg', responseType:'arraybuffer'});
    
    const prompt = `Tugas: Audit Kepatuhan Kurir (Paket GAGAL).
    Remarks Kurir: "TIDAK ADA PESAN BARANG".
    Aturan SAH:
    1. WAJIB ada bukti screenshot Chat WA atau Riwayat Telpon. Screenshot bisa berada di foto mana saja (First Prove / Gallery).
    2. Jika itu Chat WA, periksa centangnya. Centang 1, Centang 2 Abu, dan Centang 2 Biru dianggap SAH.
    3. Jika ada foto screenshot chat, langsung nyatakan SAH!
    Penting: Kamu HANYA boleh membalas dalam format JSON utuh: {"valid": true/false, "alasan": "jelaskan secara singkat apa yang kamu lihat"}`;

    const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
            prompt, 
            {inlineData:{data:Buffer.from(p1.data).toString('base64'),mimeType:'image/jpeg'}}, 
            {inlineData:{data:Buffer.from(p2.data).toString('base64'),mimeType:'image/jpeg'}}
        ],
        config: {responseMimeType: 'application/json'}
    });
    console.log(res.text);
}
test();
