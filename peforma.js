const axios = require('axios');
const fs = require('fs');
const xlsx = require('xlsx');
const { getValidToken } = require('./audit_system/jne_auth.js');

const courierId = process.argv[2];
if (!courierId) {
    console.error("No Courier ID");
    process.exit(1);
}

const isSemua = courierId.toUpperCase() === 'SEMUA';

// Fungsi untuk membuat warna acak di grafik
function getRandomColor(index) {
    const colors = [
        'rgb(255, 99, 132)', 'rgb(54, 162, 235)', 'rgb(255, 206, 86)',
        'rgb(75, 192, 192)', 'rgb(153, 102, 255)', 'rgb(255, 159, 64)',
        'rgb(199, 199, 199)', 'rgb(83, 102, 255)', 'rgb(255, 102, 255)',
        'rgb(102, 255, 102)', 'rgb(255, 102, 102)', 'rgb(102, 102, 255)'
    ];
    return colors[index % colors.length];
}

async function run() {
    const token = await getValidToken();
    let awbHistory = {}; 
    const today = new Date();
    
    // Tarik 10 hari ke belakang
    for (let i = 10; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const pad = n => n < 10 ? '0' + n : n;
        const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
        
        try {
            const url = isSemua 
                ? `https://sca.jne.id/lm-api/dashboard/report?from=${dateStr}&to=${dateStr}&result_type=list`
                : `https://sca.jne.id/lm-api/dashboard/report?from=${dateStr}&to=${dateStr}&courier_id=${courierId}&result_type=list`;
                
            const res = await axios.get(url, { headers: { Authorization: token } });
            const list = res.data.data || [];
            
            for (let item of list) {
                const awb = item.DRSHEET_CNOTE_NO;
                if (!awb) continue;
                
                const currentCid = item.MRSHEET_COURIER_ID ? item.MRSHEET_COURIER_ID.toUpperCase() : 'UNKNOWN';
                const cName = item.COURIER_NAME || item.MRSHEET_COURIER_NAME || item.DRSHEET_COURIER_NAME || currentCid;
                
                if (!awbHistory[awb]) {
                    awbHistory[awb] = { 
                        dates: new Set(), 
                        finalStatus: '', 
                        isSuccess: false,
                        receiver: item.CNOTE_RECEIVER_NAME || '',
                        address: item.CNOTE_RECEIVER_ADDR1 || '',
                        courierId: currentCid,
                        courierName: cName
                    };
                }
                awbHistory[awb].dates.add(dateStr);
                
                // Track latest status
                if (i === 0 || !awbHistory[awb].finalStatus || !awbHistory[awb].isSuccess) {
                    awbHistory[awb].finalStatus = item.POD_STATUS || item.DRSHEET_STATUS || 'On Process';
                    awbHistory[awb].isSuccess = item.DRSHEET_STATUS && item.DRSHEET_STATUS.startsWith('D');
                    // Update the courier info to the latest person carrying it
                    awbHistory[awb].courierId = currentCid;
                    awbHistory[awb].courierName = cName;
                }
            }
        } catch(e) {}
    }
    
    // Olah data Excel dan Hitungan Chart
    let excelData = [];
    let courierPerformance = {}; // { 'PKU1151': { name: '..', H+0: 0, H+1: 0 } }
    
    // Inisialisasi struktur
    const hKeys = ['H+0', 'H+1', 'H+2', 'H+3', 'H+4', 'H+5', 'H+6', 'H+7', '>H+7'];
    
    // Global stats for single courier chart (Sukses vs Gagal)
    let globalStats = {};
    hKeys.forEach(k => globalStats[k] = { success: 0, fail: 0 });

    for (let awb in awbHistory) {
        let hist = awbHistory[awb];
        const h = hist.dates.size - 1;
        let key = h > 7 ? '>H+7' : `H+${h}`;
        
        let cid = hist.courierId;
        if (!courierPerformance[cid]) {
            courierPerformance[cid] = { name: hist.courierName };
            hKeys.forEach(k => courierPerformance[cid][k] = 0);
        }
        
        // Update Chart Stats
        if (hist.isSuccess) {
            courierPerformance[cid][key]++;
            globalStats[key].success++;
        } else {
            globalStats[key].fail++;
        }
        
        excelData.push({
            'Kurir ID': cid,
            'Nama Kurir': hist.courierName,
            'Resi': awb,
            'Penerima': hist.receiver,
            'Alamat': hist.address,
            'Status Akhir': hist.isSuccess ? 'SUKSES' : 'GAGAL',
            'Keterangan JNE': hist.finalStatus,
            'Umur Paket': key,
            'Total Hari Dibawa': hist.dates.size,
            'Riwayat Tanggal': [...hist.dates].join(', ')
        });
    }
    
    if (excelData.length === 0) {
        console.log("KOSONG");
        return;
    }
    
    excelData.sort((a, b) => b['Total Hari Dibawa'] - a['Total Hari Dibawa']);
    
    // Generate Excel
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(excelData);
    xlsx.utils.book_append_sheet(wb, ws, "Laporan Peforma");
    const excelFile = `peforma_${courierId}.xlsx`;
    xlsx.writeFile(wb, excelFile);
    
    // Generate Chart
    let datasets = [];
    
    if (isSemua) {
        // Mode SEMUA: Bandingkan Jumlah Sukses antar semua kurir
        let colorIdx = 0;
        for (let cid in courierPerformance) {
            let dataArr = hKeys.map(k => courierPerformance[cid][k]);
            
            // Skip kurir yang datanya kosong melompong (tidak ada paket sukses)
            if (dataArr.every(val => val === 0)) continue;
            
            datasets.push({
                label: `${cid} (${courierPerformance[cid].name})`,
                borderColor: getRandomColor(colorIdx),
                backgroundColor: 'transparent',
                data: dataArr,
                fill: false,
                tension: 0.4
            });
            colorIdx++;
        }
    } else {
        // Mode 1 Kurir: Bandingkan Sukses vs Gagal
        const dataSuccess = hKeys.map(k => globalStats[k].success);
        const dataFail = hKeys.map(k => globalStats[k].fail);
        datasets.push({ label: 'Sukses (Delivered)', borderColor: 'rgb(75, 192, 192)', backgroundColor: 'rgba(75, 192, 192, 0.2)', data: dataSuccess, fill: true, tension: 0.4 });
        datasets.push({ label: 'Gagal / Pending', borderColor: 'rgb(255, 99, 132)', backgroundColor: 'rgba(255, 99, 132, 0.2)', data: dataFail, fill: true, tension: 0.4 });
    }
    
    const chartConfig = {
        type: 'line',
        data: {
            labels: hKeys,
            datasets: datasets
        },
        options: {
            title: { display: true, text: isSemua ? `Adu Mekanik Peforma Sukses Semua Kurir` : `Peforma Sukses vs Gagal Kurir ${courierId}` },
        }
    };
    
    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=1000&h=500&bkg=white`;
    
    try {
        const response = await axios({ url: chartUrl, responseType: 'arraybuffer' });
        fs.writeFileSync(`peforma_${courierId}.png`, response.data);
    } catch (e) {
        console.error("Gagal buat chart", e.message);
    }
    
    console.log("SUCCESS");
}

run();
