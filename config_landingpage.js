// config_landingpage.js

// URL Backend Server Express Anda
// Jika dijalankan di lokal, gunakan http://localhost:3000
// Jika di server live (Railway/VPS), sesuaikan domain backend Anda
const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : 'https://nodejs-pesan-antar.up.railway.app'; // Ganti dengan domain Railway backend Anda