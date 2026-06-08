const fs = require('fs');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const path = require('path');

// ==========================================
// KONFIGURASI AUDIT
// ==========================================
const DATA_FILE = 'C:/Users/USER/Desktop/Resi_PKU862.json';
const OUTPUT_PDF = path.join(__dirname, 'Laporan_Audit_Sukses_PKU862.pdf');

// Folder sementara untuk menyimpan gambar bukti
const TEMP_IMG_DIR = path.join(__dirname, 'temp_images');
if (!fs.existsSync(TEMP_IMG_DIR)) fs.mkdirSync(TEMP_IMG_DIR);

/**
 * FUNGSI MOCK AI VISION (Pura-puranya ini adalah otak AI)
 * Nanti kita akan ganti ini dengan Google Gemini Vision API yang sesungguhnya!
 */
async function periksaGambarDenganAIVision(imageUrl, awb) {
    console.log(`[AI VISION] Sedang memeriksa gambar untuk resi ${awb}...`);
    
    // Karena ini masih "Mock" (Simulasi), kita akan buat AI secara acak menemukan kesalahan
        // Di dunia nyata, AI akan benar-benar "melihat" piksel gambarnya.
        // SOP BARU:
        // 1. Wajah pakai masker/tertutup BOLEH, asalkan ujung kepala hingga dagu nampak.
        // 2. Jika barang tidak terlihat di foto (tapi ada orangnya), status BOLEH BENAR ASAL ada lampiran bukti chat.
        
        const isSesuaiSOP = Math.random() > 0.5; // 50% kemungkinan sukses, 50% gagal

        if (isSesuaiSOP) {
            return { valid: true, alasan: "Sesuai SOP (Ujung kepala hingga dagu terlihat / Ada orang & bukti chat)" };
        } else {
            // AI menemukan kesalahan
            const daftarKesalahan = [
                "Hanya memfoto kardus di lantai, tidak ada penerima, dan tidak ada bukti chat.",
                "Bagian kepala penerima terpotong parah (tidak terlihat utuh dari atas sampai dagu).",
                "Orang terlihat, barang tidak terlihat, dan TIDAK ADA lampiran screenshot chat."
            ];
            const alasanSalah = daftarKesalahan[Math.floor(Math.random() * daftarKesalahan.length)];
            return { valid: false, alasan: alasanSalah };
        }
    }

/**
 * Download gambar dari Huawei Cloud JNE ke lokal sementara
 */
async function downloadImage(url, filename) {
    try {
        const response = await axios({ url, responseType: 'stream' });
        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(filename);
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (e) {
        console.error(`Gagal download gambar: ${url}`);
        return null;
    }
}

/**
 * FUNGSI UTAMA: MENJALANKAN AUDIT
 */
async function jalankanAudit() {
    console.log("=========================================");
    console.log("🚀 MEMULAI SISTEM AUDIT KURIR (STATUS: SUKSES)");
    console.log("=========================================\n");

    // 1. BACA DATA
    const rawData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    const semuaResi = rawData.data;

    // 2. FILTER HANYA YANG SUKSES (Dxx)
    const resiSukses = semuaResi.filter(r => {
        const status1 = r.DRSHEET_STATUS || '';
        const status2 = r.DRSHEET_CNOTE_POD_CODE || '';
        return status1.startsWith('D') || status2.startsWith('D');
    });
    console.log(`✅ Ditemukan ${resiSukses.length} resi berstatus SUKSES (Dxx) dari total ${semuaResi.length} resi.`);

    // Batasi 5 resi saja untuk testing sistem (agar tidak terlalu lama)
    const sampelResi = resiSukses.slice(0, 5);
    
    let resiBermasalah = [];

    // 3. PROSES SATU PER SATU DENGAN AI VISION
    for (const resi of sampelResi) {
        const awb = resi.DRSHEET_CNOTE_NO;
        const fotoUrl = resi.EPOD_PIC || resi.EPOD_URL_PIC;

        if (!fotoUrl) {
            console.log(`❌ Resi ${awb} TIDAK ADA FOTO! Langsung masuk laporan pelanggaran.`);
            resiBermasalah.push({
                awb: awb,
                penerima: resi.DRSHEET_RECEIVER,
                alasan: "Sama sekali tidak ada foto yang diunggah ke sistem SCA.",
                fotoLokal: null
            });
            continue;
        }

        // Download foto
        const namaFileLokal = path.join(TEMP_IMG_DIR, `${awb}.jpg`);
        await downloadImage(fotoUrl, namaFileLokal);

        // Lempar ke AI Vision
        const hasilAi = await periksaGambarDenganAIVision(fotoUrl, awb);
        
        if (!hasilAi.valid) {
            console.log(`🚨 Ditemukan Pelanggaran pada ${awb}: ${hasilAi.alasan}`);
            resiBermasalah.push({
                awb: awb,
                penerima: resi.DRSHEET_RECEIVER,
                alasan: hasilAi.alasan,
                fotoLokal: namaFileLokal
            });
        } else {
            console.log(`✅ Resi ${awb} Aman.`);
        }
    }

    // 4. BUAT LAPORAN PDF JIKA ADA YANG BERMASALAH
    if (resiBermasalah.length > 0) {
        console.log(`\n📄 Menyusun Laporan PDF (${resiBermasalah.length} Pelanggaran)...`);
        
        const doc = new PDFDocument();
        doc.pipe(fs.createWriteStream(OUTPUT_PDF));
        
        doc.fontSize(20).text('LAPORAN AUDIT KURIR JNE', { align: 'center' });
        doc.fontSize(12).text(`ID Kurir: PKU862`, { align: 'center' });
        doc.text(`Tanggal Audit: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);

        doc.fontSize(14).fillColor('red').text(`PERINGATAN: Ditemukan ${resiBermasalah.length} Resi dengan Evidence Tidak Sesuai SOP!`);
        doc.moveDown();

        for (const r of resiBermasalah) {
            doc.fontSize(12).fillColor('black').text(`-------------------------------------------------`);
            doc.text(`No Resi  : ${r.awb}`);
            doc.text(`Penerima : ${r.penerima}`);
            doc.fillColor('red').text(`Komentar AI: ${r.alasan}`);
            doc.fillColor('black').moveDown();

            if (r.fotoLokal && fs.existsSync(r.fotoLokal)) {
                // Masukkan gambar ke dalam PDF (lebar 300px agar tidak kepenuhan)
                doc.image(r.fotoLokal, { width: 300 });
                doc.moveDown(2);
            }
        }

        doc.end();
        console.log(`\n🎯 SELESAI! Laporan berhasil dicetak: ${OUTPUT_PDF}`);
    } else {
        console.log(`\n🎯 SELESAI! Semua evidence kurir sesuai SOP. Tidak ada PDF yang perlu dicetak.`);
    }
}

jalankanAudit();
