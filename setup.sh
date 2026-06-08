#!/bin/bash
echo "======================================"
echo "🚀 MENGINSTALL DEPENDENSI JNE BOT..."
echo "======================================"
pkg update -y
pkg upgrade -y
pkg install nodejs git -y
npm install
echo "======================================"
echo "✅ INSTALASI SELESAI!"
echo "Untuk menjalankan bot, ketik:"
echo "node index.js"
echo "======================================"
