const axios = require('axios');
const fs = require('fs');
const xlsx = require('xlsx');
const { getValidToken } = require('./audit_system/jne_auth.js');

const courierId = process.argv[2];
if (!courierId) {
    console.error("No Courier ID");
    process.exit(1);
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
            const url = `https://sca.jne.id/lm-api/dashboard/report?from=${dateStr}&to=${dateStr}&courier_id=${courierId}&result_type=list`;
            const res = await axios.get(url, { headers: { Authorization: token } });
            const list = res.data.data || [];
            
            for (let item of list) {
                const awb = item.DRSHEET_CNOTE_NO;
                if (!awb) continue;
                if (!awbHistory[awb]) {
                    awbHistory[awb] = { 
                        dates: new Set(), 
                        finalStatus: '', 
                        isSuccess: false,
                        receiver: item.CNOTE_RECEIVER_NAME || '',
                        address: item.CNOTE_RECEIVER_ADDR1 || '',
                        courierName: item.COURIER_NAME || item.MRSHEET_COURIER_NAME || item.DRSHEET_COURIER_NAME || courierId
                    };
                }
                awbHistory[awb].dates.add(dateStr);
                
                // Track latest status
                if (i === 0 || !awbHistory[awb].finalStatus || !awbHistory[awb].isSuccess) {
                    awbHistory[awb].finalStatus = item.POD_STATUS || item.DRSHEET_STATUS || 'On Process';
                    awbHistory[awb].isSuccess = item.DRSHEET_STATUS && item.DRSHEET_STATUS.startsWith('D');
                }
            }
        } catch(e) {}
    }
    
    // Olah data Excel
    let excelData = [];
    let hCounts = {
        'H+0': { success: 0, fail: 0 },
        'H+1': { success: 0, fail: 0 },
        'H+2': { success: 0, fail: 0 },
        'H+3': { success: 0, fail: 0 },
        'H+4': { success: 0, fail: 0 },
        'H+5': { success: 0, fail: 0 },
        'H+6': { success: 0, fail: 0 },
        'H+7': { success: 0, fail: 0 },
        '>H+7': { success: 0, fail: 0 }
    };
    
    let cName = courierId;
    for (let awb in awbHistory) {
        let hist = awbHistory[awb];
        cName = hist.courierName; // Ambil nama asli jika ada
        const h = hist.dates.size - 1;
        let key = h > 7 ? '>H+7' : `H+${h}`;
        
        if (hist.isSuccess) {
            hCounts[key].success++;
        } else {
            hCounts[key].fail++;
        }
        
        excelData.push({
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
    const labels = Object.keys(hCounts);
    const dataSuccess = labels.map(k => hCounts[k].success);
    const dataFail = labels.map(k => hCounts[k].fail);
    
    const chartConfig = {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                { label: 'Sukses (Delivered)', borderColor: 'rgb(75, 192, 192)', backgroundColor: 'rgba(75, 192, 192, 0.2)', data: dataSuccess, fill: true, tension: 0.4 },
                { label: 'Gagal / Pending', borderColor: 'rgb(255, 99, 132)', backgroundColor: 'rgba(255, 99, 132, 0.2)', data: dataFail, fill: true, tension: 0.4 }
            ]
        },
        options: {
            title: { display: true, text: `Grafik Garis Peforma Kurir ${cName} (${courierId})` },
        }
    };
    
    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=800&h=400&bkg=white`;
    
    try {
        const response = await axios({ url: chartUrl, responseType: 'arraybuffer' });
        fs.writeFileSync(`peforma_${courierId}.png`, response.data);
    } catch (e) {
        console.error("Gagal buat chart", e.message);
    }
    
    console.log("SUCCESS");
}

run();
