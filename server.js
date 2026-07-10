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
    host: process.env.MYSQLHOST || 'mysql.railway.internal',
    user: process.env.MYSQLUSER || 'root',      
    password: process.env.MYSQLPASSWORD || 'bQJkvxVCYjzQsTjSXySibRILeBXMQvko',      
    database: process.env.MYSQL_DATABASE || 'beda', // Mengambil 'beda' dari environment variable
    port: process.env.MYSQLPORT || 3306
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
// FUNGSIONALITAS HELPER MULTI-TENANT
// ==========================================

// Helper untuk membuat slug otomatis dari nama warung (Contoh: "Warung Bu Kris" -> "warung-bu-kris")
function generateSlug(text) {
    return text.toString().toLowerCase().trim()
        .replace(/\s+/g, '-')           // Ganti spasi dengan -
        .replace(/[^\w\-]+/g, '')       // Hapus karakter non-word
        .replace(/\-\-+/g, '-');        // Ganti multi - dengan tunggal -
}

// Helper untuk validasi slug warung dan mengambil ID warung aslinya
async function getShopIdBySlug(connectionOrPool, slug) {
    if (!slug) return null;
    const [rows] = await connectionOrPool.query('SELECT id FROM shops WHERE slug = ?', [slug]);
    return rows.length > 0 ? rows[0].id : null;
}


// ==========================================
// ENDPOINT BARU: AUTENTIKASI LOGIN (POST)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validasi input kosong
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username dan password wajib diisi!' });
        }

        // Cari toko berdasarkan username di tabel 'shops'
        const [rows] = await pool.query('SELECT * FROM shops WHERE username = ?', [username]);

        // Jika username tidak ditemukan
        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Username atau password salah.' });
        }

        const shop = rows[0];

        // Validasi Password (String biasa sesuai kebutuhan pengujian saat ini)
        if (shop.password !== password) {
            return res.status(401).json({ success: false, message: 'Username atau password salah.' });
        }

        // Jika login sukses, kembalikan data esensial ke frontend
        res.json({
            success: true,
            message: 'Login berhasil!',
            shop_id: shop.id,
            shop_name: shop.shop_name,
            slug: shop.slug
        });

    } catch (error) {
        console.error("Error saat login:", error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan internal server: ' + error.message });
    }
});


// ==========================================
// ENDPOINT: PENDAFTARAN WARUNG DENGAN AUTH (POST)
// ==========================================
app.post('/api/shops/register', async (req, res) => {
    try {
        const { shop_name, owner_name, username, password } = req.body;
        
        if (!shop_name || !owner_name || !username || !password) {
            return res.status(400).json({ success: false, message: 'Semua field (Nama warung, pemilik, username, password) wajib diisi.' });
        }

        let slug = generateSlug(shop_name);

        // Cek apakah slug sudah dipakai warung lain, jika ya tambahkan angka acak di belakangnya
        const [slugRows] = await pool.query('SELECT id FROM shops WHERE slug = ?', [slug]);
        if (slugRows.length > 0) {
            slug = `${slug}-${Math.floor(1000 + Math.random() * 9000)}`;
        }

        // Cek apakah username sudah dipakai oleh warung lain
        const [userRows] = await pool.query('SELECT id FROM shops WHERE username = ?', [username]);
        if (userRows.length > 0) {
            return res.status(400).json({ success: false, message: 'Username sudah digunakan oleh warung lain.' });
        }

        // Simpan warung baru beserta username, password, dan is_open (Default: 1 / Buka) ke database
        const [result] = await pool.query(
            'INSERT INTO shops (shop_name, owner_name, slug, username, password, is_open) VALUES (?, ?, ?, ?, ?, 1)',
            [shop_name, owner_name, slug, username, password]
        );

        res.status(201).json({
            success: true,
            message: 'Warung berhasil didaftarkan!',
            data: { id: result.insertId, shop_name, slug, username }
        });
    } catch (error) {
        console.error("Error saat mendaftarkan warung:", error);
        res.status(500).json({ success: false, message: 'Gagal mendaftarkan warung ke database: ' + error.message });
    }
});


// ==========================================
// ENDPOINT: TAMBAH PRODUK BARU (POST) - MULTI-TENANT
// ==========================================
app.post('/api/products', upload.single('foto_produk'), async (req, res) => {
    try {
        const { nama_produk, harga, kategori, deskripsi, shop } = req.body; // 'shop' berisi slug warung dari frontend
        
        // 🚨 PERBAIKAN: Menggunakan objek 'pool' secara langsung alih-alih variabel 'connection' yang tidak terdefinisi
        const shopId = await getShopIdBySlug(pool, shop);
        
        if (!shopId) {
            return res.status(404).json({ success: false, message: 'Warung tidak terdaftar atau parameter shop tidak valid.' });
        }

        // Cek apakah file foto berhasil diunggah
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Foto produk wajib diunggah.' });
        }

        // Jalur url foto yang disimpan ke database
        const urlFoto = `/uploads/${req.file.filename}`;

        // PROSES SIMPAN KE DATABASE MYSQL (Tabel products disertai shop_id)
        const queryText = `
            INSERT INTO products (shop_id, name, price, category, description, image_url) 
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        
        // Eksekusi query menggunakan pool
        await pool.query(queryText, [shopId, nama_produk, harga, kategori, deskripsi || '', urlFoto]);

        console.log('Produk Baru Berhasil Disimpan:', { shopId, nama_produk, harga, kategori, urlFoto });

        res.status(201).json({
            success: true,
            message: 'Produk baru berhasil ditambahkan ke database!',
            data: { shop_id: shopId, nama_produk, harga, kategori, deskripsi, foto: urlFoto }
        });

    } catch (error) {
        console.error("Error saat menyimpan produk:", error);
        res.status(500).json({ success: false, message: "Gagal menyimpan produk ke database: " + error.message });
    }
});


// ==========================================
// ENDPOINT 1: PEMBELI MENGIRIM PESANAN (POST) - MULTI-TENANT
// ==========================================
app.post('/api/orders', async (req, res) => {
    const { customer_name, customer_phone, table_or_address, total_price, items, shop } = req.body;

    if (!items || items.length === 0) {
        return res.status(400).json({ success: false, message: "Keranjang belanja kosong" });
    }

    const connection = await pool.getConnection();

    try {
        // Cari ID warung berdasarkan slug-nya
        const shopId = await getShopIdBySlug(connection, shop);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak terdaftar." });
        }

        await connection.beginTransaction();

        const orderQuery = `
            INSERT INTO orders (shop_id, customer_name, customer_phone, table_or_address, total_price, status)
            VALUES (?, ?, ?, ?, ?, 'baru')
        `;
        const [orderResult] = await connection.query(orderQuery, [shopId, customer_name, customer_phone, table_or_address, total_price]);
        
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
// ENDPOINT 2: PENJUAL MELIHAT ANTREAN (GET) - MULTI-TENANT
// ==========================================
app.get('/api/orders/active', async (req, res) => {
    try {
        const shopSlug = req.query.shop;
        const shopId = await getShopIdBySlug(pool, shopSlug);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });
        }

        const queryText = `
            SELECT 
                o.id AS order_id, o.customer_name, o.customer_phone, o.table_or_address, 
                o.total_price, o.status, o.created_at,
                p.name AS nama_makanan, oi.quantity, oi.notes AS catatan_item
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE o.shop_id = ? AND o.status IN ('baru', 'proses')
            ORDER BY o.created_at ASC
        `;
        const [rows] = await pool.query(queryText, [shopId]);
        
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
// ENDPOINT 4: PENJUAL MELIHAT RIWAYAT (GET) - MULTI-TENANT
// ==========================================
app.get('/api/orders/history', async (req, res) => {
    try {
        const shopSlug = req.query.shop;
        const shopId = await getShopIdBySlug(pool, shopSlug);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });
        }

        const queryText = `
            SELECT 
                o.id AS order_id, o.customer_name, o.customer_phone, o.table_or_address, 
                o.total_price, o.status, o.created_at,
                p.name AS nama_makanan, oi.quantity, oi.notes AS catatan_item
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE o.shop_id = ? AND o.status = 'selesai'
            ORDER BY o.created_at DESC;
        `;
        const [rows] = await pool.query(queryText, [shopId]);
        
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
// ENDPOINT: AMBIL SEMUA PRODUK UNTUK PEMBELI (GET) - MULTI-TENANT
// ==========================================
app.get('/api/products', async (req, res) => {
    try {
        const shopSlug = req.query.shop;
        const shopId = await getShopIdBySlug(pool, shopSlug);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan.", data: [] });
        }

        // Ambil data produk yang hanya milik warung terpilih
        const [rows] = await pool.query('SELECT * FROM products WHERE shop_id = ? ORDER BY id DESC', [shopId]);
        
        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("Error ambil data produk:", error);
        res.status(500).json({ success: false, message: "Gagal mengambil daftar daftar produk dari database" });
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
// Menggunakan port dari Railway, jika tidak ada baru gunakan 3000 (untuk lokal)
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server berjalan di port ${PORT}`);
});
