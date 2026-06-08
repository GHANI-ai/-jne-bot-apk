const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const JNE_EMAIL = '3310134206930001';
const JNE_PASSWORD = 'y3#DeZ7o';
const TOTP_SECRET = 'EVKSG535EY5DSTS2';
const LOGIN_URL = 'https://sca.jne.id/lm-api/user/auth/login';

const TOKEN_FILE = path.join(__dirname, '.jne_token.json');

function generateTOTP() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let buf = [];
    let bits = 0;
    let value = 0;
    for (let i = 0; i < TOTP_SECRET.length; i++) {
        value = (value << 5) | alphabet.indexOf(TOTP_SECRET[i].toUpperCase());
        bits += 5;
        if (bits >= 8) {
            buf.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    const key = Buffer.from(buf);
    const epoch = Math.floor(Date.now() / 1000);
    const time = Buffer.alloc(8);
    time.writeUInt32BE(Math.floor(epoch / 30), 4);
    const hmac = crypto.createHmac('sha1', key).update(time).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
    return (code % 1000000).toString().padStart(6, '0');
}

async function performLogin() {
    console.log('🔄 [JNE-AUTH] Melakukan proses Auto-Login ke SCA JNE...');
    const otp = generateTOTP();
    
    try {
        const response = await axios.post(LOGIN_URL, {
            email: JNE_EMAIL,
            password: JNE_PASSWORD,
            totp: otp
        }, { timeout: 10000 });
        
        if (response.data && response.data.success) {
            const token = response.data.data.access_token;
            const payloadBase64 = token.split('.')[1];
            const payloadStr = Buffer.from(payloadBase64, 'base64').toString('utf8');
            const payloadData = JSON.parse(payloadStr);
            
            const tokenData = {
                token: `Bearer ${token}`,
                expiresAt: payloadData.exp * 1000
            };
            
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
            console.log('✅ [JNE-AUTH] Login Berhasil! Token baru telah disimpan.');
            return tokenData.token;
        } else {
            throw new Error("Gagal login: " + JSON.stringify(response.data));
        }
    } catch (e) {
        console.error('❌ [JNE-AUTH] Auto-Login Gagal:', e.response ? e.response.data : e.message);
        throw e;
    }
}

async function getValidToken() {
    if (fs.existsSync(TOKEN_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
            const now = Date.now();
            if (now < data.expiresAt - (5 * 60 * 1000)) {
                return data.token;
            }
        } catch (e) {
            console.error('[JNE-AUTH] Gagal membaca token cache, akan login ulang.');
        }
    }
    return await performLogin();
}

module.exports = { getValidToken };
