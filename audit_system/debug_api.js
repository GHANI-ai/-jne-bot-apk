const axios = require('axios');
const { getValidToken } = require('./jne_auth');
async function run() {
    const token = await getValidToken();
    const url = 'https://sca.jne.id/lm-api/dashboard/report?&from=2026-06-06&to=2026-06-06&courier_id=PKU1299&result_type=list';
    const res = await axios.get(url, { headers: { Authorization: token } });
    console.log(JSON.stringify(res.data.data[0], null, 2));
}
run();
