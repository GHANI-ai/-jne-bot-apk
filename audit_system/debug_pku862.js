const axios = require('axios');
const { getValidToken } = require('./jne_auth');
async function run() {
    const token = await getValidToken();
    let date = '2026-06-06';
    await axios.post('https://sca.jne.id/lm-api/sync/delivery?refresh=true', { from: date, to: date, couriers: ['PKU862'] }, { headers: { Authorization: token } });
    let urlDetail = `https://sca.jne.id/lm-api/dashboard/report?&from=${date}&to=${date}&courier_id=PKU862&result_type=list`;
    let res = await axios.get(urlDetail, { headers: { Authorization: token } });
    console.log('PKU862 2026-06-06:', res.data.data ? res.data.data.length : 0);
    
    date = '2026-06-07';
    await axios.post('https://sca.jne.id/lm-api/sync/delivery?refresh=true', { from: date, to: date, couriers: ['PKU862'] }, { headers: { Authorization: token } });
    urlDetail = `https://sca.jne.id/lm-api/dashboard/report?&from=${date}&to=${date}&courier_id=PKU862&result_type=list`;
    res = await axios.get(urlDetail, { headers: { Authorization: token } });
    console.log('PKU862 2026-06-07:', res.data.data ? res.data.data.length : 0);
}
run();
