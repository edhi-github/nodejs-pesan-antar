const express = require('express');
const mysql = require('mysql2/promise'); 
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'); // Tambahan untuk R2
const crypto = require('crypto'); // Tambahan untuk penamaan file acak

const app = express();

app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// CONFIGURATION DATABASE MYSQL
const dbConfig = {
    host: process.env.MYSQLHOST || 'mysql.railway.internal',
    user: process.env.MYSQLUSER || 'root',      
    password: process.env.MYSQLPASSWORD || 'bQJkvxVCYjzQsTjSXySibRILeBXMQvko',      
    database: process.env.MYSQL_DATABASE || 'beda', 
    port: process.env.MYSQLPORT || 3306
};

const pool = mysql.createPool(dbConfig);

// ==========================================
// CONFIGURATION CLOUDFLARE R2 (S3-COMPATIBLE)
// ==========================================
const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT, // Contoh: https://<account_id>.r2.cloudflarestorage.com
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// Gunakan memoryStorage agar file tidak disimpan di hardisk Railway, melainkan di RAM sementara
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Hanya file gambar yang diizinkan!'), false);
    }
};

const upload = multer({ storage: storage, fileFilter: fileFilter });

const { GetObjectCommand } = require("@aws-sdk/client-s3"); // Pastikan import ini ada di atas

// ENDPOINT PROXY UNTUK MENGAMBIL GAMBAR DARI R2
app.get('/api/images/:filename', async (req, res) => {
    try {
        const { filename } = req.params;

        const command = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: filename,
        });

        const response = await s3.send(command);
        
        // Atur Content-Type sesuai tipe gambar (png/jpeg)
        res.setHeader('Content-Type', response.ContentType || 'image/jpeg');
        
        // Alirkan (pipe) data gambar langsung ke browser frontend
        response.Body.pipe(res);
    } catch (error) {
        console.error("Gagal mengambil gambar dari R2:", error);
        res.status(404).send("Gambar tidak ditemukan");
    }
});


// ==========================================
// FUNGSIONALITAS HELPER MULTI-TENANT
// ==========================================
function generateSlug(text) {
    return text.toString().toLowerCase().trim()
        .replace(/\s+/g, '-')           
        .replace(/[^\w\-]+/g, '')       
        .replace(/\-\-+/g, '-');        
}

async function getShopIdBySlug(connectionOrPool, slug) {
    if (!slug) return null;
    const [rows] = await connectionOrPool.query('SELECT id FROM shops WHERE slug = ?', [slug]);
    return rows.length > 0 ? rows[0].id : null;
}


// ==========================================
// ENDPOINT: AUTENTIKASI LOGIN (POST)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username dan password wajib diisi!' });
        }

        const [rows] = await pool.query('SELECT * FROM shops WHERE username = ?', [username]);

        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Username atau password salah.' });
        }

        const shop = rows[0];

        if (shop.password !== password) {
            return res.status(401).json({ success: false, message: 'Username atau password salah.' });
        }

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

        const [slugRows] = await pool.query('SELECT id FROM shops WHERE slug = ?', [slug]);
        if (slugRows.length > 0) {
            slug = `${slug}-${Math.floor(1000 + Math.random() * 9000)}`;
        }

        const [userRows] = await pool.query('SELECT id FROM shops WHERE username = ?', [username]);
        if (userRows.length > 0) {
            return res.status(400).json({ success: false, message: 'Username sudah digunakan oleh warung lain.' });
        }

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
// ENDPOINT: TAMBAH PRODUK BARU (POST) - CLOUDFLARE R2 INTEGRATION
// ==========================================
app.post('/api/products', upload.single('foto_produk'), async (req, res) => {
    try {
        const { nama_produk, harga, kategori, deskripsi, shop } = req.body; 
        
        const shopId = await getShopIdBySlug(pool, shop);
        if (!shopId) {
            return res.status(404).json({ success: false, message: 'Warung tidak terdaftar atau parameter shop tidak valid.' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Foto produk wajib diunggah.' });
        }

        // --- PROSES UPLOAD KE CLOUDFLARE R2 ---
        const fileExtension = req.file.originalname.split('.').pop();
        const uniqueFilename = `product-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${fileExtension}`;

        const uploadParams = {
            Bucket: process.env.R2_BUCKET_NAME,
            Key: uniqueFilename,
            Body: req.file.buffer, // Mengambil buffer data dari memoryStorage
            ContentType: req.file.mimetype,
        };

        // Eksekusi kirim ke Cloudflare R2
        await s3.send(new PutObjectCommand(uploadParams));

        // Gabungkan URL publik Cloudflare dengan nama file unik
        const urlFoto = `${process.env.R2_PUBLIC_URL}/${uniqueFilename}`;

        // SIMPAN KE DATABASE MYSQL (Sekarang menggunakan urlFoto dari Cloudflare)
        const queryText = `
            INSERT INTO products (shop_id, name, price, category, description, image_url) 
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        
        await pool.query(queryText, [shopId, nama_produk, harga, kategori, deskripsi || '', urlFoto]);

        console.log('Produk Baru Berhasil Disimpan ke R2:', { shopId, nama_produk, urlFoto });

        res.status(201).json({
            success: true,
            message: 'Produk baru berhasil ditambahkan dan disimpan di Cloudflare R2!',
            data: { shop_id: shopId, nama_produk, harga, kategori, deskripsi, foto: urlFoto }
        });

    } catch (error) {
        console.error("Error saat menyimpan produk:", error);
        res.status(500).json({ success: false, message: "Gagal menyimpan produk: " + error.message });
    }
});


// ==========================================
// ENDPOINT: PEMBELI MENGIRIM PESANAN (POST)
// ==========================================
app.post('/api/orders', async (req, res) => {
    const { customer_name, customer_phone, table_or_address, total_price, items, shop } = req.body;

    if (!items || items.length === 0) {
        return res.status(400).json({ success: false, message: "Keranjang belanja kosong" });
    }

    const connection = await pool.getConnection();

    try {
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
// ENDPOINT: PENJUAL MELIHAT ANTREAN (GET)
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
// ENDPOINT: PENJUAL KLIK SELESAI (PATCH)
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
// ENDPOINT: PENJUAL MELIHAT RIWAYAT (GET)
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
// ENDPOINT: AMBIL SEMUA PRODUK UNTUK PEMBELI (GET)
// ==========================================
app.get('/api/products', async (req, res) => {
    try {
        const shopSlug = req.query.shop;
        const shopId = await getShopIdBySlug(pool, shopSlug);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan.", data: [] });
        }

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
    const { is_available } = req.body; 

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server berjalan di port ${PORT}`);
});