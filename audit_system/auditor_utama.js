require('./keys_manager');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const { GoogleGenAI } = require('@google/genai');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// ⚙️ KONFIGURASI PENGGUNA
// ==========================================
const DATE = process.argv[3] || "2026-06-06"; // Tanggal yang ingin diaudit
const COURIER_ID = process.argv[2] || "PKU1151"; 
const { getValidToken } = require('./jne_auth');
// MULTI-KEY ROTATION SYSTEM
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || "ISI_API_KEY_ANDA_DISINI").split(',').map(k => k.trim());
let currentKeyIndex = 0;
function getNextKey() {
    const key = GEMINI_API_KEYS[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
    return key;
}

// OPENROUTER KEY SYSTEM
const OPENROUTER_API_KEYS = (process.env.OPENROUTER_API_KEYS || "").split(',').map(k => k.trim()).filter(k => k.length > 0);
let currentOpenRouterIndex = 0;
function getNextOpenRouterKey() {
    if (OPENROUTER_API_KEYS.length === 0) return null;
    const key = OPENROUTER_API_KEYS[currentOpenRouterIndex];
    currentOpenRouterIndex = (currentOpenRouterIndex + 1) % OPENROUTER_API_KEYS.length;
    return key;
}

// ==========================================
// 🗂️ PENGATURAN FOLDER LAPORAN
// ==========================================
const BASE_REPORT_DIR = path.join(__dirname, 'Laporan', DATE);
if (!fs.existsSync(path.join(__dirname, 'Laporan'))) fs.mkdirSync(path.join(__dirname, 'Laporan'));
if (!fs.existsSync(BASE_REPORT_DIR)) fs.mkdirSync(BASE_REPORT_DIR);

// ==========================================
// 🛠️ FUNGSI: MENGAMBIL DATA & GAMBAR (KE MEMORI)
// ==========================================
async function tarikDataJNE(date, courierId, token) {
    const url = `https://sca.jne.id/lm-api/dashboard/report?&from=${date}&to=${date}&courier_id=${courierId}&result_type=list`;
    const res = await axios.get(url, { headers: { "Authorization": token, "Accept": "application/json, text/plain, */*" } });
    if (!res.data.success) throw new Error("Gagal menarik data JNE.");
    return res.data.data || [];
}

/**
 * Mengambil gambar dan menyimpannya langsung ke Memory (Buffer)
 * tanpa membuat file sementara di Hardisk.
 */
async function fetchImageBuffer(url) {
    if (!url) return null;
    try {
        const res = await axios({ url, responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(res.data, 'binary'); // Kirim gambar mentah (Lebih stabil untuk Termux)
    } catch (e) {
        return null;
    }
}

// ==========================================
// 🧠 FUNGSI: MATA AI VISION & PENGECEKAN RULES LOGIC
// ==========================================

async function periksaPelanggaran(resi, fotoFirstProveBuffer, fotoUtamaBuffer, fotoChatBuffer) {
    const remarks = (resi.DRSHEET_REMARKS || '').trim().toLowerCase();
    const namaPenerima = (resi.CNOTE_RECEIVER_NAME || '').trim().toLowerCase();

    // RULE 1: Tidak ada foto sama sekali
    if (!fotoFirstProveBuffer && !fotoUtamaBuffer && !fotoChatBuffer) {
        return { valid: false, alasan: "Kurir sama sekali tidak mengunggah bukti foto / gambar kosong di semua slot (First Prove, Picture, maupun Gallery)." };
    }

    const prompt = `Tugas: Audit Kepatuhan Kurir (Paket SUKSES).
       PENTING: Kamu akan menerima 1-3 gambar. Gambar pertama biasanya HANYA Tanda Tangan (Abaikan tanda tangan, jangan jadikan ini sebagai satu-satunya dasar). FOKUS cari wajah manusia dan paket pada gambar kedua atau ketiga!
       
       SYARAT SAH LOLOS AUDIT (Harus penuhi SALAH SATU jalur ini):
       1. JALUR NORMAL: Ada gambar orang bersama barangnya. Syarat mutlak: WAJIB nampak anggota tubuh penerima (kepala, punggung, badan, atau minimal tangan yang sedang memegang paket). Paket harus terlihat di dalam foto (meskipun bentuknya kecil atau tertutup plastik, asalkan ada bentuk barang paket, maka SAH).
       2. JALUR PIHAK KE-3 / KAPAL: Ada foto pengantaran via kapal/boat atau dititipkan ke sekuriti berseragam. (SAH).
       3. JALUR TITIP (SAFE PLACE): Jika paket ditaruh di box, meja, rak, pagar, atau lantai tanpa ada foto orang, TETAPI ADA foto screenshot chat persetujuan penerima (misal: "taruh aja di box bang", "oke", "siap", "sudah ditaruh ya"), maka itu SAH.

       PELANGGARAN (TIDAK SAH): 
       - Jika gambar BENAR-BENAR HANYA paket digeletakkan di lantai/meja tanpa ada orang sama sekali, DAN TIDAK ADA screenshot chat persetujuan.
       - Jika DARI SEMUA GAMBAR hanya berisi foto tanda tangan putih polos tanpa ada foto orang/paket sama sekali.
       
       ATURAN BAHASA: DILARANG KERAS menggunakan istilah terjemahan mesin yang aneh seperti "mangsa tak terlihat". Gunakan bahasa Indonesia yang profesional (contoh: "Penerima tidak terlihat di foto", "Hanya paket di lantai tanpa chat").
       
       Balas HANYA format JSON utuh: {"valid": true/false, "alasan": "JIKA valid=true biarkan KOSONG (''). JIKA valid=false tulis pelanggarannya SINGKAT (maks 6-8 kata)."}`;

    let retries = 10;
    while (retries > 0) {
        try {
            const orKey = getNextOpenRouterKey();
            if (!orKey) return { valid: false, alasan: "[ERROR] OPENROUTER_API_KEYS kosong di .env" };

            const contentArray = [{ type: "text", text: prompt }];
            if (fotoFirstProveBuffer) contentArray.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fotoFirstProveBuffer.toString("base64")}` } });
            if (fotoUtamaBuffer) contentArray.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fotoUtamaBuffer.toString("base64")}` } });
            if (fotoChatBuffer) contentArray.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fotoChatBuffer.toString("base64")}` } });

            const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
                model: "qwen/qwen-2.5-vl-72b-instruct",
                messages: [{ role: "user", content: contentArray }],
                response_format: { type: "json_object" }
            }, {
                headers: { "Authorization": `Bearer ${orKey}`, "Content-Type": "application/json" },
                timeout: 60000 // Waktu tunggu dilonggarkan jadi 60 detik untuk amannya
            });

            const hasilTeks = response.data.choices[0].message.content.replace(/```json/g, "").replace(/```/g, "").trim();
            const hasilAI = JSON.parse(hasilTeks);
            const alasanTeks = hasilAI.alasan || hasilAI.reason || hasilAI.keterangan || "Tidak ada alasan spesifik (Dinilai cacat oleh Qwen)";
            return { valid: hasilAI.valid, alasan: alasanTeks };

        } catch (e) {
            retries--;
            if (retries === 0) {
                return { valid: false, alasan: `[ERROR QWEN OPENROUTER] ${e.response?.data?.error?.message || e.message}` };
            }
            // Delay acak (2-4 detik) agar jika banyak request gagal bersamaan, tidak menumpuk saat mencoba lagi
            const randomDelay = Math.floor(Math.random() * 2000) + 2000;
            console.log(`[Limit/Timeout] Server sibuk, mencoba ulang dalam ${randomDelay/1000} detik... (Sisa Nyawa: ${retries})`);
            await delay(randomDelay);
        }
    }
}

// ==========================================
// 📄 FUNGSI: MENCETAK TABEL KE PDF (DARI MEMORI)
// ==========================================
function cetakLaporanTabelPDF(pelanggaran, filepath, jenisAudit) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
        doc.pipe(fs.createWriteStream(filepath));

        function drawHeader() {
            doc.fontSize(18).fillColor(jenisAudit === 'SUKSES' ? 'green' : 'red').text(`Laporan Pelanggaran Closing (${jenisAudit})`, 30, 30, { align: 'center' });
            doc.fontSize(10).fillColor('black').text(`ID Kurir: ${COURIER_ID} | Tanggal Audit: ${DATE} | Total: ${pelanggaran.length} resi`, { align: 'center' });
            doc.moveDown(2);

            const tableTop = doc.y;
            const colNo = 30;
            const colResi = 50;
            const colTipe = 130;
            const colPenerima = 170;
            const colRemarks = 260;
            const colGambar = 380;
            const colAlasan = 630;

            doc.fontSize(10).font('Helvetica-Bold');
            doc.text('No', colNo, tableTop);
            doc.text('Resi', colResi, tableTop);
            doc.text('Tipe', colTipe, tableTop);
            doc.text('Penerima', colPenerima, tableTop);
            doc.text('Remarks', colRemarks, tableTop);
            doc.text('Gambar (First Prove, EPOD, Chat)', colGambar, tableTop);
            doc.text('Alasan / Pelanggaran', colAlasan, tableTop);
            
            doc.moveTo(30, tableTop + 15).lineTo(810, tableTop + 15).stroke();
            doc.font('Helvetica');
            return tableTop + 25;
        }

        let y = drawHeader();

        pelanggaran.forEach((r, i) => {
            // Prediksi apakah butuh halaman baru (asumsi 1 baris max 120px)
            if (y > 460) {
                doc.addPage();
                y = drawHeader();
            }

            const colNo = 30;
            const colResi = 50;
            const colTipe = 130;
            const colPenerima = 170;
            const colRemarks = 260;
            const colGambar = 380;
            const colAlasan = 630;

            doc.fontSize(9);
            doc.fillColor('black').text(`${i + 1}`, colNo, y);
            doc.text(`${r.awb}`, colResi, y);
            doc.fillColor(r.tipe === 'COD' ? 'orange' : 'blue').text(`${r.tipe}`, colTipe, y);
            doc.fillColor('black').text(`${r.penerima}`, colPenerima, y, { width: 85 });
            doc.fillColor('purple').text(`${r.remarks}`, colRemarks, y, { width: 110 });
            
            // Catat Y sebelum cetak alasan untuk menghitung tinggi teks
            const textStartY = y;
            doc.fillColor('red').text(`${r.alasan}`, colAlasan, y, { width: 180 });
            doc.fillColor('black');
            
            let textHeight = doc.y - textStartY;

            // Cetak 3 gambar berjajar
            let imgX = colGambar;
            let imgMaxHeight = 0;
            const imgWidth = 75; // Ukuran proporsional gambar
            
            if (r.fotoFirstProveBuffer) {
                try { doc.image(r.fotoFirstProveBuffer, imgX, y, { width: imgWidth }); imgMaxHeight = Math.max(imgMaxHeight, 100); } catch(e){}
                imgX += imgWidth + 5;
            } else { imgX += imgWidth + 5; }
            
            if (r.fotoUtamaBuffer) {
                try { doc.image(r.fotoUtamaBuffer, imgX, y, { width: imgWidth }); imgMaxHeight = Math.max(imgMaxHeight, 100); } catch(e){}
                imgX += imgWidth + 5;
            } else { imgX += imgWidth + 5; }
            
            if (r.fotoChatBuffer) {
                try { doc.image(r.fotoChatBuffer, imgX, y, { width: imgWidth }); imgMaxHeight = Math.max(imgMaxHeight, 100); } catch(e){}
            }

            // Tinggi baris ditentukan oleh yang paling besar: Teks atau Gambar
            const rowHeight = Math.max(textHeight, imgMaxHeight) + 10;
            
            y += rowHeight;
            doc.moveTo(30, y - 5).lineTo(810, y - 5).strokeColor('#cccccc').stroke();
            doc.strokeColor('black');
            y += 5;
        });

        doc.end();
        doc.on('end', resolve);
    });
}

// ==========================================
// 🚀 FUNGSI UTAMA: PROSES AUDIT KESELURUHAN
// ==========================================
async function jalankanSistemAudit() {
    console.log("=========================================");
    console.log("👮‍♂️ SISTEM AUDIT KURIR JNE MULAI BEKERJA");
    console.log("=========================================\n");

    try {
        const validToken = await getValidToken();
        const semuaResiAsli = await tarikDataJNE(DATE, COURIER_ID, validToken);
        
        // HANYA AMBIL PAKET SUKSES (Berawalan D seperti D01, D09, dll)
        const semuaResi = semuaResiAsli.filter(r => (r.DRSHEET_STATUS || '').startsWith('D'));

        if (semuaResi.length === 0) {
            console.log(`✅ Tidak ada paket SUKSES untuk kurir ${COURIER_ID}. Audit dibatalkan.`);
            return;
        }

        console.log(`✅ Berhasil menarik TOTAL ${semuaResi.length} resi. Proses Audit Keseluruhan dimulai...`);

        const laporanPelanggaran = [];
        const CONCURRENCY = 15; // Proses 15 resi secara paralel karena kita punya banyak API key
        let processed = 0;

        for (let i = 0; i < semuaResi.length; i += CONCURRENCY) {
            const batch = semuaResi.slice(i, i + CONCURRENCY);
            
            const batchPromises = batch.map(async (resi) => {
                const awb = resi.DRSHEET_CNOTE_NO;

                // Tarik SEMUA gambar ke Memori (Buffer) termasuk First Prove (EPOD)
                const bufferFirstProve = await fetchImageBuffer(resi.EPOD || resi.EPOD_URL);
                const bufferUtama = await fetchImageBuffer(resi.EPOD_PIC || resi.EPOD_URL_PIC);
                const bufferChat = await fetchImageBuffer(resi.EPOD_URL_PIC_1);

                // Lakukan Pengecekan AI dan Logic Rules
                const hasilCek = await periksaPelanggaran(resi, bufferFirstProve, bufferUtama, bufferChat);

                // Deteksi COD (Biasanya memiliki tagihan BILNOTE_AMOUNT atau EPAY_TTL_AMT)
                const isCOD = (resi.BILNOTE_AMOUNT > 0) || (resi.DRSHEET_EPAY_TTL_AMT > 0);
                const tipePembayaran = isCOD ? 'COD' : 'NON-COD';

                if (!hasilCek.valid) {
                    return {
                        awb: awb,
                        tipe: tipePembayaran,
                        statusType: 'SUKSES',
                        penerima: resi.CNOTE_RECEIVER_NAME || 'Unknown',
                        remarks: resi.DRSHEET_REMARKS || '-',
                        alasan: hasilCek.alasan,
                        fotoFirstProveBuffer: bufferFirstProve,
                        fotoUtamaBuffer: bufferUtama,
                        fotoChatBuffer: bufferChat
                    };
                }
                return null;
            });

            // Tunggu semua proses dalam batch selesai
            const batchResults = await Promise.all(batchPromises);
            
            // Masukkan yang melanggar ke dalam array laporan
            batchResults.forEach(res => {
                if (res) laporanPelanggaran.push(res);
            });

            processed += batch.length;
            process.stdout.write(`\r🔍 Memproses resi secara paralel [${processed}/${semuaResi.length}] ...`);
        }

        console.log(`\n\nSelesai mengecek ${semuaResi.length} resi!`);

        if (laporanPelanggaran.length > 0) {
            console.log(`📄 Menyusun PDF Tabel (${laporanPelanggaran.length} Pelanggaran)...`);
            
            const pdfSukses = path.join(BASE_REPORT_DIR, `Audit_SUKSES_${COURIER_ID}.pdf`);
            await cetakLaporanTabelPDF(laporanPelanggaran, pdfSukses, 'SUKSES');
            console.log(`✅ File PDF Laporan Pelanggaran SUKSES berhasil dibuat: ${pdfSukses}`);
            console.log(`✨ Tidak ada file gambar sementara (Temp Images) yang disimpan di hardisk Anda!`);
        } else {
            console.log(`\n🎯 SELESAI! Semua evidence 100% bersih dan sesuai SOP. ACC Closing.`);
        }

    } catch (err) {
        console.error("\n❌ Terjadi Kesalahan Kritis:", err.message);
    }
}

jalankanSistemAudit();
