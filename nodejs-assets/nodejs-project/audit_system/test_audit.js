require('dotenv').config();
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
const JNE_BEARER_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiMzcwMDEwZGUtYWE5ZC00MTRmLWE4ZDMtYTAyOTRlMjJmZGI0IiwidXNlcl9yb2xlX2lkIjoiVVNFUiIsImlhdCI6MTc4MDcxMjAzOCwiZXhwIjoxNzgwNzk4NDM4fQ.3MuhYgnHI-QqAhmCL_NUJp7F5X68RcOrmc5FzWDrJvw"; 

// MULTI-KEY ROTATION SYSTEM
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || "ISI_API_KEY_ANDA_DISINI").split(',').map(k => k.trim());
let currentKeyIndex = 0;
function getNextKey() {
    const key = GEMINI_API_KEYS[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
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
    const response = await fetch(url, { headers: { "Authorization": token, "Accept": "application/json, text/plain, */*" } });
    if (!response.ok) throw new Error("Gagal menarik data JNE. Token kedaluwarsa!");
    const data = await response.json();
    return data.data || [];
}

/**
 * Mengambil gambar dan menyimpannya langsung ke Memory (Buffer)
 * tanpa membuat file sementara di Hardisk.
 */
async function fetchImageBuffer(url) {
    if (!url) return null;
    try {
        const res = await axios({ url, responseType: 'arraybuffer' });
        return Buffer.from(res.data, 'binary');
    } catch (e) {
        return null;
    }
}

// ==========================================
// 🧠 FUNGSI: MATA AI VISION & PENGECEKAN RULES LOGIC
// ==========================================
async function periksaPelanggaran(resi, fotoFirstProveBuffer, fotoUtamaBuffer, fotoChatBuffer) {
    const statusType = (resi.DRSHEET_STATUS || '').startsWith('D') ? 'SUKSES' : 'GAGAL';
    const remarks = (resi.DRSHEET_REMARKS || '').trim().toLowerCase();
    const namaPenerima = (resi.CNOTE_RECEIVER_NAME || '').trim().toLowerCase();

    // RULE 1: Cek Anomali Remarks vs Nama Penerima
    if (remarks === namaPenerima) {
        if (statusType === 'GAGAL') {
            return { valid: false, alasan: `Remarks Gagal Tidak Valid! Alasan tertulis nama penerima ("${resi.DRSHEET_REMARKS}"), seharusnya diisi alasan kegagalan.` };
        }
    }

    // RULE 2: Tidak ada foto sama sekali
    if (!fotoFirstProveBuffer && !fotoUtamaBuffer && !fotoChatBuffer) {
        return { valid: false, alasan: "Kurir sama sekali tidak mengunggah bukti foto / gambar kosong di semua slot (First Prove, Picture, maupun Gallery)." };
    }

    // RULE 3: Panggil Mata AI Google Gemini (Asli!)
    // Karena kita sudah pakai Multi-Key, kita TIDAK PERLU MEMATIKAN AI UNTUK PAKET SUKSES!
    // Semua paket akan dilahap habis oleh armada API Key kita.
    
    let retries = 10;
    while (retries > 0) {
        try {
            await delay(2000);

            const ai = new GoogleGenAI({ apiKey: getNextKey() });
            
            const imageParts = [];
            if (fotoFirstProveBuffer) imageParts.push({ inlineData: { data: fotoFirstProveBuffer.toString("base64"), mimeType: "image/jpeg" } });
            if (fotoUtamaBuffer) imageParts.push({ inlineData: { data: fotoUtamaBuffer.toString("base64"), mimeType: "image/jpeg" } });
            if (fotoChatBuffer) imageParts.push({ inlineData: { data: fotoChatBuffer.toString("base64"), mimeType: "image/jpeg" } });

            const prompt = statusType === 'SUKSES' 
            ? `Tugas: Audit Kepatuhan Kurir (Paket SUKSES).
               Aturan SAH:
               1. WAJIB terlihat postur tubuh manusia (minimal dada sampai kepala).
               2. JIKA HANYA FOTO BARANG (paket ditaruh di lantai/meja/pagar) atau HANYA FOTO TANGAN memegang paket TANPA terlihat kepala/wajah/tubuh utuh, maka itu PELANGGARAN (Tidak SAH)!
               3. JIKA ada foto screenshot chat WA konfirmasi persetujuan dari penerima (meskipun tidak ada foto orang), itu tetap dianggap SAH.
               
               Penting: Kamu HANYA boleh membalas dalam format JSON utuh: {"valid": true/false, "alasan": "Tuliskan alasan yang SANGAT DETAIL dan LENGKAP (minimal 20-30 kata) mengenai apa saja wujud yang kamu lihat di foto tersebut, jangan disingkat."}`
            : `Tugas: Audit Kepatuhan Kurir (Paket GAGAL).
               Remarks Kurir: "${remarks}".
               Aturan SAH:
               1. WAJIB ada bukti tangkapan layar (screenshot) Chat WA, SMS, atau Riwayat Panggilan Telepon.
               2. JIKA ada screenshot Chat/SMS, BACA isi teksnya. Isi percakapan harus nyambung/sesuai dengan alasan pada Remarks Kurir ("${remarks}").
               3. JIKA foto berupa Riwayat Panggilan (Log Telepon keluar), maka langsung nyatakan SAH.
               4. JIKA gambar HANYA menampilkan foto paket, resi, atau lantai TANPA ada screenshot chat/telepon sama sekali, maka itu PELANGGARAN (Tidak SAH).
               
               Penting: Kamu HANYA boleh membalas dalam format JSON utuh: {"valid": true/false, "alasan": "Tuliskan alasan yang SANGAT DETAIL dan LENGKAP (minimal 20-30 kata). Jelaskan apakah ada bukti chat, apa isi pesannya, dan kenapa itu sesuai atau tidak sesuai dengan remarks."}`;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [prompt, ...imageParts],
                config: { responseMimeType: "application/json" }
            });

            const hasilAI = JSON.parse(response.text);
            // Tangkap berbagai kemungkinan gaya bahasa AI agar tidak "undefined"
            const alasanTeks = hasilAI.alasan || hasilAI.reason || hasilAI.keterangan || hasilAI.pesan || "Tidak ada alasan spesifik (Foto dinilai tidak sah oleh AI)";
            return { valid: hasilAI.valid, alasan: alasanTeks };

        } catch (e) {
            if (e.message.includes("429") || e.message.includes("Quota") || e.message.includes("503") || e.message.includes("UNAVAILABLE") || e.message.includes("403") || e.message.includes("PERMISSION_DENIED")) {
                retries--;
                if (retries === 0) return { valid: false, alasan: `[LIMIT HARIAN HABIS] Google menolak memproses karena ke-10 Kunci API Anda telah mencapai batas maksimal harian.` };
                console.log(`[Limit] Kunci penuh, ganti ke kunci berikutnya...`);
            } else {
                return { valid: false, alasan: `[ERROR API VISION] ${e.message}` };
            }
        }
    }
}

// ==========================================
// 📄 FUNGSI: MENCETAK TABEL KE PDF (DARI MEMORI)
// ==========================================
function cetakLaporanTabelPDF(pelanggaran, filepath, jenisAudit) {
    return new Promise((resolve) => {
        // Gunakan landscape agar tabel muat banyak kolom
        const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
        doc.pipe(fs.createWriteStream(filepath));

        // HEADER
        doc.fontSize(18).fillColor(jenisAudit === 'SUKSES' ? 'green' : 'red').text(`Laporan Pelanggaran Closing (${jenisAudit})`, { align: 'center' });
        doc.fontSize(10).fillColor('black').text(`ID Kurir: ${COURIER_ID} | Tanggal Audit: ${DATE}`, { align: 'center' });
        doc.text(`Total Pelanggaran: ${pelanggaran.length} resi`, { align: 'center' });
        doc.moveDown(2);

        // SETUP TABLE (Lebar total landscape = 841, Useable = ~780)
        const tableTop = 100;
        const colNo = 30;
        const colResi = 60;
        const colTipe = 160;
        const colStatus = 220;
        const colPenerima = 280;
        const colRemarks = 400;
        const colAlasan = 550;

        // PRINT HEADER TABEL
        doc.fontSize(10).font('Helvetica-Bold');
        doc.text('No', colNo, tableTop);
        doc.text('Resi', colResi, tableTop);
        doc.text('Tipe', colTipe, tableTop);
        doc.text('Status', colStatus, tableTop);
        doc.text('Penerima', colPenerima, tableTop);
        doc.text('Remarks Kurir', colRemarks, tableTop);
        doc.text('Alasan / Pelanggaran (Mata AI)', colAlasan, tableTop);
        
        doc.moveTo(30, tableTop + 15).lineTo(810, tableTop + 15).stroke();
        doc.font('Helvetica');

        let y = tableTop + 25;

        // LOOP BARIS
        pelanggaran.forEach((r, i) => {
            if (y > 450) { // Batas landscape agak pendek
                doc.addPage();
                y = 50;
            }

            doc.fontSize(9);
            doc.fillColor('black').text(`${i + 1}`, colNo, y);
            doc.text(`${r.awb}`, colResi, y);
            
            // Kolom Tipe (COD/NON-COD)
            doc.fillColor(r.tipe === 'COD' ? 'orange' : 'blue').text(`${r.tipe}`, colTipe, y);
            
            // Kolom Status
            doc.fillColor(r.statusType === 'SUKSES' ? 'green' : 'red').text(`${r.statusType}`, colStatus, y);
            
            // Kolom Penerima
            doc.fillColor('black').text(`${r.penerima}`, colPenerima, y, { width: 110 });
            
            // Kolom Remarks Kurir
            doc.fillColor('purple').text(`${r.remarks}`, colRemarks, y, { width: 140 });

            // Kolom Alasan Pelanggaran
            doc.fillColor('red').text(`${r.alasan}`, colAlasan, y, { width: 250 });
            doc.fillColor('black');

            const highestTextY = doc.y; 
            y = highestTextY + 10;

            // Cetak gambar (Jika ada)
            let imgX = colAlasan;
            let imgHeight = 0;
            if (r.fotoFirstProveBuffer) {
                try { doc.image(r.fotoFirstProveBuffer, imgX, y, { width: 80 }); imgX += 85; imgHeight = 100; } catch (e) {}
            }
            if (r.fotoUtamaBuffer) {
                try { doc.image(r.fotoUtamaBuffer, imgX, y, { width: 80 }); imgX += 85; imgHeight = 100; } catch (e) {}
            }
            if (r.fotoChatBuffer) {
                try { doc.image(r.fotoChatBuffer, imgX, y, { width: 80 }); imgHeight = 100; } catch (e) {}
            }
            y += imgHeight > 0 ? imgHeight + 10 : 10;

            doc.moveTo(30, y).lineTo(810, y).strokeColor('#cccccc').stroke();
            y += 10;
            doc.strokeColor('black');
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
        const semuaResi = await tarikDataJNE(DATE, COURIER_ID, JNE_BEARER_TOKEN);
        console.log(`✅ Berhasil menarik TOTAL ${semuaResi.length} resi. Proses Audit Keseluruhan dimulai...`);

        const laporanPelanggaran = [];

        for (let i = 0; i < semuaResi.length; i++) {
            const resi = semuaResi[i];
            const awb = resi.DRSHEET_CNOTE_NO;
            const statusType = (resi.DRSHEET_STATUS || '').startsWith('D') ? 'SUKSES' : 'GAGAL';
            
            process.stdout.write(`\r🔍 Memproses resi [${i+1}/${semuaResi.length}] : ${awb}...`);

            // Tarik SEMUA gambar ke Memori (Buffer) termasuk First Prove (EPOD)
            const bufferFirstProve = await fetchImageBuffer(resi.EPOD || resi.EPOD_URL);
            const bufferUtama = await fetchImageBuffer(resi.EPOD_PIC || resi.EPOD_URL_PIC);
            const bufferChat = await fetchImageBuffer(resi.EPOD_URL_PIC_1);

            // Lakukan Pengecekan AI dan Logic Rules
            const hasilCek = await periksaPelanggaran(resi, bufferFirstProve, bufferUtama, bufferChat);

            // Deteksi COD (Biasanya memiliki tagihan BILNOTE_AMOUNT atau EPAY_TTL_AMT)
            const isCOD = (resi.BILNOTE_AMOUNT > 0) || (resi.DRSHEET_EPAY_TTL_AMT > 0);
            const tipePembayaran = isCOD ? 'COD' : 'NON-COD';

            console.log('\n==> ALASAN:', hasilCek.alasan); if (!hasilCek.valid) {
                laporanPelanggaran.push({
                    awb: awb,
                    tipe: tipePembayaran,
                    statusType: statusType,
                    penerima: resi.CNOTE_RECEIVER_NAME || 'Unknown',
                    remarks: resi.DRSHEET_REMARKS || '-',
                    alasan: hasilCek.alasan,
                    fotoFirstProveBuffer: bufferFirstProve,
                    fotoUtamaBuffer: bufferUtama,
                    fotoChatBuffer: bufferChat
                });
            }
        }

        console.log(`\n\nSelesai mengecek ${semuaResi.length} resi!`);

        if (laporanPelanggaran.length > 0) {
            console.log(`📄 Menyusun PDF Tabel (${laporanPelanggaran.length} Pelanggaran)...`);
            
            const pelanggaranSukses = laporanPelanggaran.filter(r => r.statusType === 'SUKSES');
            const pelanggaranGagal = laporanPelanggaran.filter(r => r.statusType === 'GAGAL');

            if (pelanggaranSukses.length > 0) {
                const pdfSukses = path.join(BASE_REPORT_DIR, `Audit_SUKSES_${COURIER_ID}.pdf`);
                await cetakLaporanTabelPDF(pelanggaranSukses, pdfSukses, 'SUKSES');
                console.log(`\n🎯 Surat tilang SUKSES berhasil dicetak:\n👉 ${pdfSukses}`);
            }

            if (pelanggaranGagal.length > 0) {
                const pdfGagal = path.join(BASE_REPORT_DIR, `Audit_GAGAL_${COURIER_ID}.pdf`);
                await cetakLaporanTabelPDF(pelanggaranGagal, pdfGagal, 'GAGAL');
                console.log(`\n🎯 Surat tilang GAGAL berhasil dicetak:\n👉 ${pdfGagal}`);
            }
            
            console.log(`✨ Tidak ada file gambar sementara (Temp Images) yang disimpan di hardisk Anda!`);
        } else {
            console.log(`\n🎯 SELESAI! Semua evidence 100% bersih dan sesuai SOP. ACC Closing.`);
        }

    } catch (err) {
        console.error("\n❌ Terjadi Kesalahan Kritis:", err.message);
    }
}

jalankanSistemAudit();
