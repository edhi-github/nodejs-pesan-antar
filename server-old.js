const express = require('express');
const mysql = require('mysql2/promise'); // Menggunakan mysql2 dengan fitur Promise (async/await)
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// CONFIGURATION DATABASE MYSQL (XAMPP)
const dbConfig = {
    host: '172.16.12.187',
    user: 'promis_manager',      
    password: 'promis_system',      
    database: 'beda', 
};

// Hubungkan ke database dengan sistem Pool agar koneksi stabil
const pool = mysql.createPool(dbConfig);

// Pastikan folder 'uploads' otomatis terbuat jika belum ada
const dir = './uploads';
if (!fs.existsSync(dir)){
    fs.mkdirSync(dir);
}

// ==========================================
// CONFIGURATION MULTER (UNGGAH GAMBAR)
// ==========================================
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/'); 
    },
    filename: function (req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Hanya file gambar yang diizinkan!'), false);
    }
};

const upload = multer({ storage: storage, fileFilter: fileFilter });

// Buat folder 'uploads' dapat diakses secara publik lewat browser/frontend
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// ==========================================
// ENDPOINT : TAMBAH PRODUK BARU (POST) - FIXED!
// ==========================================
app.post('/api/products', upload.single('foto_produk'), async (req, res) => {
    try {
        const { nama_produk, harga, kategori, deskripsi } = req.body;
        
        // Cek apakah file foto berhasil diunggah
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Foto produk wajib diunggah.' });
        }

        // Jalur url foto yang disimpan ke database
        const urlFoto = `/uploads/${req.file.filename}`;

        // PROSES SIMPAN KE DATABASE MYSQL (Tabel products)
        const queryText = `
            INSERT INTO products (name, price, category, description, image_url) 
            VALUES (?, ?, ?, ?, ?)
        `;
        
        // Eksekusi query menggunakan pool
        await pool.query(queryText, [nama_produk, harga, kategori, deskripsi || '', urlFoto]);

        console.log('Produk Baru Berhasil Disimpan:', { nama_produk, harga, kategori, urlFoto });

        res.status(201).json({
            success: true,
            message: 'Produk baru berhasil ditambahkan ke database!',
            data: { nama_produk, harga, kategori, deskripsi, foto: urlFoto }
        });

    } catch (error) {
        console.error("Error saat menyimpan produk:", error);
        res.status(500).json({ success: false, message: "Gagal menyimpan produk ke database: " + error.message });
    }
});


// ==========================================
// ENDPOINT 1: PEMBELI MENGIRIM PESANAN (POST)
// ==========================================
app.post('/api/orders', async (req, res) => {
    const { customer_name, customer_phone, table_or_address, total_price, items } = req.body;

    if (!items || items.length === 0) {
        return res.status(400).json({ success: false, message: "Keranjang belanja kosong" });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const orderQuery = `
            INSERT INTO orders (customer_name, customer_phone, table_or_address, total_price, status)
            VALUES (?, ?, ?, ?, 'baru')
        `;
        const [orderResult] = await connection.query(orderQuery, [customer_name, customer_phone, table_or_address, total_price]);
        
        const newOrderId = orderResult.insertId; 

        const itemQuery = `
            INSERT INTO order_items (order_id, product_id, quantity, notes, subtotal)
            VALUES (?, ?, ?, ?, ?)
        `;

        for (let item of items) {
            const product_id = item.product_id || 1;
            const subtotal = item.harga;
            const notes = item.catatan || '';
            
            await connection.query(itemQuery, [newOrderId, product_id, 1, notes, subtotal]);
        }

        await connection.commit();

        res.status(201).json({
            success: true,
            message: "Pesanan berhasil masuk ke antrean dapur!",
            order_id: newOrderId
        });

    } catch (error) {
        await connection.rollback();
        console.error("Error saat simpan pesanan:", error);
        res.status(500).json({ success: false, message: "Gagal memproses pesanan di server" });
    } finally {
        connection.release();
    }
});

// ==========================================
// ENDPOINT 2: PENJUAL MELIHAT ANTREAN (GET)
// ==========================================
app.get('/api/orders/active', async (req, res) => {
    try {
        const queryText = `
            SELECT 
                o.id AS order_id, o.customer_name, o.customer_phone, o.table_or_address, 
                o.total_price, o.status, o.created_at,
                p.name AS nama_makanan, oi.quantity, oi.notes AS catatan_item
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE o.status IN ('baru', 'proses')
            ORDER BY o.created_at ASC
        `;
        const [rows] = await pool.query(queryText);
        
        const ordersGrouped = {};
        rows.forEach(row => {
            if (!ordersGrouped[row.order_id]) {
                ordersGrouped[row.order_id] = {
                    id: row.order_id,
                    customer_name: row.customer_name,
                    customer_phone: row.customer_phone,
                    table_or_address: row.table_or_address,
                    total_price: row.total_price,
                    status: row.status,
                    created_at: row.created_at,
                    items: []
                };
            }
            ordersGrouped[row.order_id].items.push({
                nama: row.nama_makanan,
                kuantitas: row.quantity,
                catatan: row.catatan_item
            });
        });

        res.json(Object.values(ordersGrouped));
    } catch (error) {
        console.error("Error ambil antrean:", error);
        res.status(500).json({ success: false, message: "Gagal mengambil data antrean" });
    }
});

// ==========================================
// ENDPOINT 3: PENJUAL KLIK SELESAI (PATCH)
// ==========================================
app.patch('/api/orders/:id/complete', async (req, res) => {
    const orderId = req.params.id;
    try {
        const queryText = `UPDATE orders SET status = 'selesai' WHERE id = ?`;
        const [result] = await pool.query(queryText, [orderId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "ID Pesanan tidak ditemukan" });
        }

        res.json({ success: true, message: `Pesanan #${orderId} sukses diselesaikan!` });
    } catch (error) {
        console.error("Error update status:", error);
        res.status(500).json({ success: false, message: "Gagal memperbarui status" });
    }
});

// ==========================================
// ENDPOINT 4: PENJUAL MELIHAT RIWAYAT (GET)
// ==========================================
app.get('/api/orders/history', async (req, res) => {
    try {
        const queryText = `
            SELECT 
                o.id AS order_id, o.customer_name, o.customer_phone, o.table_or_address, 
                o.total_price, o.status, o.created_at,
                p.name AS nama_makanan, oi.quantity, oi.notes AS catatan_item
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE o.status = 'selesai'
            ORDER BY o.created_at DESC;
        `;
        const [rows] = await pool.query(queryText);
        
        const ordersGrouped = {};
        rows.forEach(row => {
            if (!ordersGrouped[row.order_id]) {
                ordersGrouped[row.order_id] = {
                    id: row.order_id,
                    customer_name: row.customer_name,
                    customer_phone: row.customer_phone,
                    table_or_address: row.table_or_address,
                    total_price: row.total_price,
                    status: row.status,
                    created_at: row.created_at,
                    items: []
                };
            }
            ordersGrouped[row.order_id].items.push({
                nama: row.nama_makanan,
                kuantitas: row.quantity,
                catatan: row.catatan_item
            });
        });

        res.json(Object.values(ordersGrouped));
    } catch (error) {
        console.error("Error ambil riwayat:", error);
        res.status(500).json({ success: false, message: "Gagal mengambil data riwayat" });
    }
});

// ==========================================
// ENDPOINT: AMBIL SEMUA PRODUK UNTUK PEMBELI (GET)
// ==========================================
app.get('/api/products', async (req, res) => {
    try {
        // Ambil semua data produk dari database
        // PENTING: Sesuaikan nama kolom (id, nama, harga, kategori, deskripsi, foto) dengan DB Anda!
        const [rows] = await pool.query('SELECT * FROM products ORDER BY id DESC');
        
        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("Error ambil data produk:", error);
        res.status(500).json({ success: false, message: "Gagal mengambil daftar produk dari database" });
    }
});

// ENDPOINT UNTUK MENGUBAH STATUS KETERSEDIAAN PRODUK (ADMIN)
app.put('/api/products/:id/toggle-available', async (req, res) => {
    const productId = req.params.id;
    const { is_available } = req.body; // Menerima nilai 1 atau 0

    try {
        const [result] = await pool.query(
            'UPDATE products SET is_available = ? WHERE id = ?',
            [is_available, productId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "Produk tidak ditemukan" });
        }

        res.json({
            success: true,
            message: `Status produk berhasil diperbarui menjadi ${is_available == 1 ? 'Tersedia' : 'Habis'}`
        });
    } catch (error) {
        console.error("Error update status produk:", error);
        res.status(500).json({ success: false, message: "Gagal memperbarui status produk" });
    }
});

// Jalankan Satu Server Terpadu di IP Lokal
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server Warung Bu Kris Terbuka di Jaringan: http://172.16.12.187:${PORT}`);
});