const express = require('express');
const mysql = require('mysql2/promise'); 
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const app = express();

app.use(express.static('public'));

// Konfigurasi CORS
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-shop-id']
}));

app.options(/(.*)/, cors());
app.use(express.json());

// CONFIGURATION DATABASE MYSQL
const dbConfig = {
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQL_DATABASE,
    port: process.env.MYSQLPORT ? parseInt(process.env.MYSQLPORT) : 3306
};

const pool = mysql.createPool(dbConfig);

// CLOUDFLARE R2
const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT, 
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
        cb(null, true);
    } else {
        cb(new Error('Hanya file gambar dan PDF yang diizinkan!'), false);
    }
};

const upload = multer({ storage: storage, fileFilter: fileFilter });

// HELPER MULTI-TENANT
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

// MIDDLEWARE KEAMANAN & SUBSCRIPTION
async function verifikasiAksesWarung(req, res, next) {
    const shopSlug = req.query.shop || (req.body && req.body.shop);
    const clientShopId = req.headers['x-shop-id']; 

    try {
        let shopIdFound = null;

        if (shopSlug) {
            const [rows] = await pool.query('SELECT id FROM shops WHERE slug = ?', [shopSlug]);
            if (rows.length === 0) {
                return res.status(404).json({ success: false, message: "Warung tidak terdaftar." });
            }
            shopIdFound = rows[0].id;
        } else if (clientShopId && clientShopId !== 'null' && clientShopId !== 'undefined') {
            const [rows] = await pool.query('SELECT id FROM shops WHERE id = ?', [clientShopId]);
            if (rows.length === 0) {
                return res.status(404).json({ success: false, message: "Warung tidak terdaftar." });
            }
            shopIdFound = rows[0].id;
        } else {
            return res.status(400).json({ 
                success: false, 
                message: "Akses ilegal: Parameter warung (shop) atau Header x-shop-id dibutuhkan." 
            });
        }

        if (clientShopId && shopIdFound && Number(clientShopId) !== shopIdFound) {
            return res.status(403).json({ success: false, message: "Akses terlarang: Token warung tidak cocok." });
        }

        next();
    } catch (error) {
        console.error("Error verifikasiAksesWarung:", error);
        res.status(500).json({ success: false, message: "Kesalahan validasi keamanan." });
    }
}

const cekMasaAktifSub = async (req, res, next) => {
    try {
        let shopId = req.headers['x-shop-id'] || req.query.shop_id;
        const shopSlug = req.query.shop || req.body.shop;

        if ((!shopId || shopId === 'null' || shopId === 'undefined') && shopSlug) {
            shopId = await getShopIdBySlug(pool, shopSlug);
        }

        if (!shopId) {
            return res.status(400).json({ success: false, message: "Shop ID atau Parameter Shop tidak ditemukan/valid" });
        }

        const [shops] = await pool.query('SELECT subscription_until FROM shops WHERE id = ?', [shopId]);
        if (shops.length === 0) {
            return res.status(404).json({ success: false, message: "Toko tidak ditemukan" });
        }

        const shop = shops[0];
        const sekarang = new Date();
        const subUntil = new Date(shop.subscription_until);

        const batasToleransi = new Date(subUntil);
        batasToleransi.setDate(batasToleransi.getDate() + 1);

        if (sekarang > batasToleransi) {
            return res.status(403).json({ 
                success: false, 
                is_expired: true,
                message: "Masa aktif dan toleransi 1 hari Anda telah habis. Silakan lakukan perpanjangan paket!" 
            });
        }

        req.shop = shop;
        next();
    } catch (error) {
        console.error("Error pada cekMasaAktifSub:", error);
        res.status(500).json({ success: false, message: "Error validasi langganan: " + error.message });
    }
};

// AUTENTIKASI LOGIN
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
            slug: shop.slug,
            app_logo: process.env.APP_LOGO_URL || "https://pub-c3b5b9a8f041497f97f050b2133dbd3a.r2.dev/logo.png"
        });
    } catch (error) {
        console.error("Error saat login:", error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan internal server: ' + error.message });
    }
});

// GET PAKET
app.get('/api/packages', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM packages WHERE is_active = 1 ORDER BY price_monthly ASC');
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error("Error ambil daftar paket:", error);
        res.status(500).json({ success: false, message: "Gagal mengambil daftar paket langganan." });
    }
});

// REGISTER WARUNG BARU
app.post('/api/register', async (req, res) => {
    const { owner_name, shop_name, slug, username, password, package_id, billing_cycle } = req.body;

    if (!owner_name || !shop_name || !slug || !username || !password) {
        return res.status(400).json({ success: false, message: "Semua field wajib diisi." });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [existingShop] = await connection.query(
            "SELECT id FROM shops WHERE slug = ? OR username = ?", 
            [slug, username]
        );

        if (existingShop.length > 0) {
            await connection.rollback();
            return res.status(400).json({ 
                success: false, 
                message: "Nama warung / Slug atau Username sudah terpakai. Silakan gunakan yang lain." 
            });
        }

        const selectedPackageId = package_id ? parseInt(package_id) : 1;
        const [pkgRows] = await connection.query('SELECT name, price_monthly, price_yearly FROM packages WHERE id = ?', [selectedPackageId]);
        const packageName = pkgRows.length > 0 ? pkgRows[0].name : 'UMKM';

        const cycle = (billing_cycle === 'yearly') ? 'yearly' : 'monthly';

        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(startDate.getDate() + 14);

        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        const [shopResult] = await connection.query(
            `INSERT INTO shops 
            (shop_name, owner_name, slug, username, password, is_open, subscription_status, subscription_until, package_id, billing_cycle) 
            VALUES (?, ?, ?, ?, ?, 1, 'trial', ?, ?, ?)`,
            [shop_name, owner_name, slug, username, password, endDateStr, selectedPackageId, cycle]
        );

        const newShopId = shopResult.insertId;

        await connection.query(
            `INSERT INTO subscriptions 
            (shop_id, package_id, package_name, amount, start_date, end_date, status, billing_cycle) 
            VALUES (?, ?, ?, 0.00, ?, ?, 'active', ?)`,
            [newShopId, selectedPackageId, `Trial 14 Hari (${packageName} - ${cycle.toUpperCase()})`, startDateStr, endDateStr, cycle]
        );

        await connection.commit();

        return res.status(201).json({
            success: true,
            message: "Registrasi mitra warung berhasil!",
            shop_id: newShopId,
            slug: slug,
            subscription_until: endDateStr,
            billing_cycle: cycle
        });

    } catch (error) {
        await connection.rollback();
        console.error("Error pendaftaran warung:", error);
        return res.status(500).json({ success: false, message: "Gagal memproses pendaftaran ke database: " + error.message });
    } finally {
        connection.release();
    }
});

// PENJUAL MELIHAT ANTREAN
app.get('/api/orders/active', verifikasiAksesWarung, async (req, res) => {
    try {
        const shopSlug = req.query.shop;
        const shopId = await getShopIdBySlug(pool, shopSlug);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });
        }

        const queryText = `
            SELECT 
                o.id AS order_id, o.customer_name, o.customer_phone, o.table_or_address, 
                o.total_price, o.tax_amount, o.status, o.created_at, o.payment_proof_url, o.payment_method,
                p.name AS nama_makanan, oi.quantity, oi.notes AS catatan_item, oi.subtotal
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
                    tax_amount: row.tax_amount,
                    status: row.status,
                    created_at: row.created_at,
                    payment_proof_url: row.payment_proof_url, 
                    payment_method: row.payment_method,
                    items: []
                };
            }
            ordersGrouped[row.order_id].items.push({
                nama: row.nama_makanan,
                kuantitas: row.quantity,
                harga: row.subtotal / row.quantity,
                catatan: row.catatan_item
            });
        });

        res.json(Object.values(ordersGrouped));
    } catch (error) {
        console.error("Error ambil antrean:", error);
        res.status(500).json({ success: false, message: "Gagal mengambil data antrean" });
    }
});

// PENJUAL KLIK SELESAI
app.patch('/api/orders/:id/complete', verifikasiAksesWarung, cekMasaAktifSub, async (req, res) => {
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

// RIWAYAT
app.get('/api/orders/history', verifikasiAksesWarung, async (req, res) => {
    try {
        const shopSlug = req.query.shop;
        const shopId = await getShopIdBySlug(pool, shopSlug);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });
        }

        const queryText = `
            SELECT 
                o.id AS order_id, o.customer_name, o.customer_phone, o.table_or_address, 
                o.total_price, o.tax_amount, o.status, o.created_at, o.updated_at, o.payment_proof_url, o.payment_method,
                p.name AS nama_makanan, oi.quantity, oi.notes AS catatan_item, oi.subtotal
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE o.shop_id = ? 
              AND o.status IN ('selesai', 'reject')
              AND o.updated_at >= CURDATE()
            ORDER BY o.updated_at DESC;
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
                    tax_amount: row.tax_amount,
                    status: row.status,
                    created_at: row.created_at,
                    updated_at: row.updated_at, 
                    payment_proof_url: row.payment_proof_url,
                    payment_method: row.payment_method,
                    items: []
                };
            }
            ordersGrouped[row.order_id].items.push({
                nama: row.nama_makanan,
                kuantitas: row.quantity,
                harga: row.subtotal / row.quantity,
                catatan: row.catatan_item
            });
        });

        res.json(Object.values(ordersGrouped));
    } catch (error) {
        console.error("Error ambil riwayat harian:", error);
        res.status(500).json({ success: false, message: "Gagal mengambil data riwayat harian" });
    }
});

// TAMBAH PRODUK
app.post('/api/products', upload.single('foto_produk'), verifikasiAksesWarung, cekMasaAktifSub, async (req, res) => {
    try {
        const nama_produk = req.body.nama_produk || req.body.name;
        const harga = req.body.harga || req.body.price;
        const kategori = req.body.kategori || req.body.category;
        const deskripsi = req.body.deskripsi || req.body.description || '';
        const { shop, stock } = req.body; 
        
        const shopId = await getShopIdBySlug(pool, shop);
        if (!shopId) {
            return res.status(404).json({ success: false, message: 'Warung tidak terdaftar atau parameter shop tidak valid.' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Foto produk wajib diunggah.' });
        }

        const fileExtension = req.file.originalname.split('.').pop();
        const uniqueFilename = `product-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${fileExtension}`;

        const uploadParams = {
            Bucket: process.env.R2_BUCKET_NAME,
            Key: uniqueFilename,
            Body: req.file.buffer, 
            ContentType: req.file.mimetype,
        };

        await s3.send(new PutObjectCommand(uploadParams));

        const urlFoto = `${process.env.R2_PUBLIC_URL}/${uniqueFilename}`;
        const inputStock = stock !== undefined ? parseInt(stock) : 20;

        const queryText = `
            INSERT INTO products (shop_id, name, price, category, description, image_url, stock) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        
        await pool.query(queryText, [shopId, nama_produk, harga, kategori, deskripsi, urlFoto, inputStock]);

        res.status(201).json({
            success: true,
            message: 'Produk baru berhasil ditambahkan!',
            data: { shop_id: shopId, nama_produk, harga, kategori, deskripsi, foto: urlFoto, stock: inputStock }
        });

    } catch (error) {
        console.error("Error saat menyimpan produk:", error);
        res.status(500).json({ success: false, message: "Gagal menyimpan produk: " + error.message });
    }
});

// UPDATE PRODUK
app.post('/api/products/:id', verifikasiAksesWarung, cekMasaAktifSub, upload.single('foto_produk'), async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const name = req.body.nama_produk || req.body.name;
        const price = req.body.harga || req.body.price;
        const category = req.body.kategori || req.body.category;
        const description = req.body.deskripsi || req.body.description || '';
        
        const parsedStock = req.body.stock !== undefined && req.body.stock !== null && req.body.stock !== '' 
            ? parseInt(req.body.stock, 10) 
            : 20;

        if (!name || !price || !category) {
            return res.status(400).json({ success: false, message: 'Nama, harga, dan kategori wajib diisi.' });
        }

        const [existingProduct] = await pool.query('SELECT image_url FROM products WHERE id = ?', [productId]);
        if (existingProduct.length === 0) {
            return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });
        }

        let urlFoto = existingProduct[0].image_url;

        if (req.file) {
            const fileExtension = req.file.originalname.split('.').pop();
            const uniqueFilename = `product-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${fileExtension}`;

            const uploadParams = {
                Bucket: process.env.R2_BUCKET_NAME,
                Key: uniqueFilename,
                Body: req.file.buffer, 
                ContentType: req.file.mimetype,
            };

            await s3.send(new PutObjectCommand(uploadParams));
            urlFoto = `${process.env.R2_PUBLIC_URL}/${uniqueFilename}`;
        }

        const queryText = `
            UPDATE products 
            SET name = ?, price = ?, category = ?, description = ?, image_url = ?, stock = ?
            WHERE id = ?
        `;
        
        await pool.query(queryText, [name, parseFloat(price), category, description, urlFoto, parsedStock, productId]);

        res.json({
            success: true,
            message: 'Produk berhasil diperbarui!',
            data: { id: productId, name, price, category, description, image_url: urlFoto, stock: parsedStock }
        });

    } catch (error) {
        console.error("Error saat memperbarui produk:", error);
        res.status(500).json({ success: false, message: "Gagal memperbarui produk: " + error.message });
    }
});

// TOGGLE BUKA/TUTUP WARUNG
app.put('/api/shops/toggle-status', verifikasiAksesWarung, cekMasaAktifSub, async (req, res) => {
    try {
        const { shop, is_open } = req.body; 

        if (!shop) {
            return res.status(400).json({ success: false, message: "Parameter shop wajib diisi." });
        }

        const shopId = await getShopIdBySlug(pool, shop);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });
        }

        const statusBaru = Number(is_open) === 1 ? 1 : 0;

        await pool.query('UPDATE shops SET is_open = ? WHERE id = ?', [statusBaru, shopId]);

        if (statusBaru === 1) {
            const [shopData] = await pool.query('SELECT default_stock_qty FROM shops WHERE id = ?', [shopId]);
            const qtyBukaToko = shopData[0]?.default_stock_qty || 20;

            await pool.query('UPDATE products SET stock = ?, is_available = 1 WHERE shop_id = ?', [qtyBukaToko, shopId]);
        }

        res.json({
            success: true,
            message: `Status warung berhasil diubah menjadi ${statusBaru == 1 ? 'Buka' : 'Tutup'}`,
            is_open: statusBaru
        });
    } catch (error) {
        console.error("Error update status warung:", error);
        res.status(500).json({ success: false, message: "Gagal memperbarui status warung" });
    }
});

// EDIT STOK DIRECT
app.put('/api/products/:id/stock', verifikasiAksesWarung, cekMasaAktifSub, async (req, res) => {
    const productId = req.params.id;
    const { stock } = req.body;

    try {
        const updateStock = parseInt(stock);
        const isAvailable = updateStock > 0 ? 1 : 0;

        await pool.query(
            'UPDATE products SET stock = ?, is_available = ? WHERE id = ?',
            [updateStock, isAvailable, productId]
        );

        res.json({ success: true, message: "Stok berhasil diperbarui!" });
    } catch (error) {
        console.error("Error update stok produk:", error);
        res.status(500).json({ success: false, message: "Gagal memperbarui stok produk" });
    }
});

// GET PRODUK PEMBELI
app.get('/api/products', async (req, res) => {
    try {
        const shopSlug = req.query.shop;
        const shopId = await getShopIdBySlug(pool, shopSlug);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan.", data: [] });
        }

        const [shopRows] = await pool.query(
            'SELECT is_open, subscription_status, subscription_until FROM shops WHERE id = ?', 
            [shopId]
        );
        
        if (shopRows.length === 0) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan.", data: [] });
        }

        const shopData = shopRows[0];
        let isOpenStatus = Number(shopData.is_open);
        let isExpired = false;

        if (shopData.subscription_status === 'expired') {
            isOpenStatus = 0;
            isExpired = true;
        }

        if (shopData.subscription_until) {
            const sekarang = new Date();
            const subUntil = new Date(shopData.subscription_until);
            const batasToleransi = new Date(subUntil);
            batasToleransi.setDate(batasToleransi.getDate() + 1);

            if (sekarang > batasToleransi) {
                isOpenStatus = 0;
                isExpired = true;
            }
        }

        const queryText = `
            SELECT * FROM products 
            WHERE shop_id = ? 
            ORDER BY id DESC
        `;
        const [rows] = await pool.query(queryText, [shopId]);

        res.json({
            success: true,
            is_open: isOpenStatus,
            is_expired: isExpired,
            data: rows
        });
    } catch (error) {
        console.error("Error ambil data produk:", error);
        res.status(500).json({ success: false, message: "Gagal mengambil daftar produk dari database" });
    }
});

// ==========================================
// AUTO-REVERT STOK KADALUARSA (RUN EVERY 30 DETIK)
// ==========================================
setInterval(async () => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Cari pesanan pending yang melewati 5 menit tanpa konfirmasi/upload bukti
        const [expiredOrders] = await connection.query(`
            SELECT id FROM orders 
            WHERE status = 'pending' 
              AND created_at < NOW() - INTERVAL 5 MINUTE
            FOR UPDATE
        `);

        for (let order of expiredOrders) {
            const [items] = await connection.query(
                'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
                [order.id]
            );

            for (let item of items) {
                await connection.query(
                    'UPDATE products SET stock = stock + ? WHERE id = ?',
                    [item.quantity, item.product_id]
                );
            }

            await connection.query(
                "UPDATE orders SET status = 'reject' WHERE id = ?",
                [order.id]
            );
        }

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        console.error("Error auto-revert expired reservations:", error);
    } finally {
        connection.release();
    }
}, 30000);

// ==========================================
// 1. ENDPOINT: PEMBELI RESERVASI STOK (SAAT KLIK "LANJUT PESAN")
// ==========================================
app.post('/api/orders/reserve', async (req, res) => {
    const { items, shop } = req.body;

    let parsedItems = [];
    try {
        parsedItems = typeof items === 'string' ? JSON.parse(items) : items;
    } catch (e) {
        return res.status(400).json({ success: false, message: "Format item pesanan tidak valid." });
    }

    if (!parsedItems || parsedItems.length === 0) {
        return res.status(400).json({ success: false, message: "Keranjang belanja kosong." });
    }

    const connection = await pool.getConnection();

    try {
        const shopId = await getShopIdBySlug(connection, shop);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak terdaftar." });
        }

        const [shopRows] = await connection.query('SELECT has_tax, tax_percentage FROM shops WHERE id = ?', [shopId]);
        const hasTax = shopRows[0]?.has_tax === 1;
        const taxPercentage = parseFloat(shopRows[0]?.tax_percentage || 0);

        await connection.beginTransaction();

        // Count per product ID
        const itemQuantities = {};
        for (let item of parsedItems) {
            itemQuantities[item.product_id] = (itemQuantities[item.product_id] || 0) + 1;
        }

        let calculatedSubtotal = 0;

        // Kunci baris dengan FOR UPDATE & validasi stok real-time
        for (let productId in itemQuantities) {
            const qtyNeeded = itemQuantities[productId];
            const [prodRows] = await connection.query(
                'SELECT id, name, price, stock, is_available FROM products WHERE id = ? FOR UPDATE',
                [productId]
            );

            if (prodRows.length === 0 || prodRows[0].is_available === 0 || prodRows[0].stock < qtyNeeded) {
                const namaProduk = prodRows[0]?.name || 'Produk terpilih';
                const err = new Error(`Maaf, "${namaProduk}" baru saja diambil pelanggan lain / kehabisan stok!`);
                err.out_of_stock_id = productId;
                err.product_name = namaProduk;
                throw err;
            }

            calculatedSubtotal += parseFloat(prodRows[0].price) * qtyNeeded;
        }

        let taxAmount = 0;
        let finalTotalPrice = calculatedSubtotal;
        if (hasTax && taxPercentage > 0) {
            taxAmount = (calculatedSubtotal * taxPercentage) / 100;
            finalTotalPrice = calculatedSubtotal + taxAmount;
        }

        // POTONG STOK LANGSUNG SAAT RESERVASI
        for (let productId in itemQuantities) {
            const qtyNeeded = itemQuantities[productId];
            await connection.query('UPDATE products SET stock = stock - ? WHERE id = ?', [qtyNeeded, productId]);
        }

        // Buat order awal berstatus 'pending'
        const orderQuery = `
            INSERT INTO orders (shop_id, total_price, tax_amount, status, payment_method)
            VALUES (?, ?, ?, 'pending', 'transfer')
        `;
        const [orderResult] = await connection.query(orderQuery, [shopId, finalTotalPrice, taxAmount]);
        const newOrderId = orderResult.insertId;

        const itemQuery = `
            INSERT INTO order_items (order_id, product_id, quantity, notes, subtotal)
            VALUES (?, ?, ?, ?, ?)
        `;

        for (let item of parsedItems) {
            await connection.query(itemQuery, [newOrderId, item.product_id, 1, item.catatan || '', item.harga]);
        }

        await connection.commit();

        // Berikan batas waktu reservasi 5 menit
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        res.status(201).json({
            success: true,
            message: "Stok berhasil dikunci selama 5 menit!",
            order_id: newOrderId,
            total_price: finalTotalPrice,
            expires_at: expiresAt.toISOString()
        });

    } catch (error) {
        await connection.rollback();
        console.error("Error reservasi stok:", error);
        res.status(400).json({ 
            success: false, 
            message: error.message,
            out_of_stock_id: error.out_of_stock_id || null,
            product_name: error.product_name || null
        });
    } finally {
        connection.release();
    }
});

// ==========================================
// 2. ENDPOINT: PEMBELI MENGONFIRMASI DATA PESANAN
// ==========================================
app.post('/api/orders/:id/confirm', async (req, res) => {
    const orderId = req.params.id;
    const { customer_name, customer_phone, table_or_address, payment_method } = req.body;

    if (!customer_name || !customer_phone || !table_or_address) {
        return res.status(400).json({ success: false, message: "Data pemesan tidak lengkap." });
    }

    try {
        const [rows] = await pool.query('SELECT status FROM orders WHERE id = ?', [orderId]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Pesanan tidak ditemukan." });
        }

        if (rows[0].status === 'reject') {
            return res.status(400).json({ success: false, message: "Reservasi stok Anda telah dibatalkan karena waktu habis." });
        }

        const metodePembayaran = payment_method || 'transfer';
        // Jika cash, langsung ubah status ke 'baru'. Jika transfer, tetap 'pending' sampai upload bukti
        const statusAkhir = metodePembayaran === 'cash' ? 'baru' : 'pending';

        await pool.query(
            "UPDATE orders SET customer_name = ?, customer_phone = ?, table_or_address = ?, payment_method = ?, status = ? WHERE id = ?",
            [customer_name, customer_phone, table_or_address, metodePembayaran, statusAkhir, orderId]
        );

        res.json({
            success: true,
            message: "Data pemesan berhasil disimpan!",
            order_id: orderId,
            status: statusAkhir
        });

    } catch (error) {
        console.error("Error konfirmasi order:", error);
        res.status(500).json({ success: false, message: "Gagal mengonfirmasi pesanan." });
    }
});

// ==========================================
// 3. ENDPOINT: UPLOAD BUKTI BAYAR UNTUK RESERVASI
// ==========================================
app.post('/api/orders/:id/upload-proof', upload.single('payment_proof'), async (req, res) => {
    const orderId = req.params.id;

    if (!req.file) {
        return res.status(400).json({ success: false, message: "Bukti pembayaran wajib diunggah." });
    }

    try {
        const [rows] = await pool.query('SELECT status FROM orders WHERE id = ?', [orderId]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Pesanan tidak ditemukan." });
        }

        if (rows[0].status === 'reject') {
            return res.status(400).json({ success: false, message: "Waktu reservasi Anda telah habis/dibatalkan." });
        }

        const fileExtension = req.file.originalname.split('.').pop();
        const uniqueFilename = `proof-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${fileExtension}`;

        const uploadParams = {
            Bucket: process.env.R2_BUCKET_NAME,
            Key: uniqueFilename,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        };

        await s3.send(new PutObjectCommand(uploadParams));
        const urlBuktiBayar = `${process.env.R2_PUBLIC_URL}/${uniqueFilename}`;

        // Ubah status ke 'baru' agar penjual melihat pesanan di dashboard
        await pool.query(
            "UPDATE orders SET payment_proof_url = ?, status = 'baru' WHERE id = ?",
            [urlBuktiBayar, orderId]
        );

        res.json({
            success: true,
            message: "Bukti pembayaran berhasil diunggah!",
            payment_proof_url: urlBuktiBayar
        });

    } catch (error) {
        console.error("Error upload bukti bayar:", error);
        res.status(500).json({ success: false, message: "Gagal mengunggah bukti bayar: " + error.message });
    }
});

// ==========================================
// 4. ENDPOINT: MEMBATALKAN RESERVASI (JIKA USER TUTUP MODAL)
// ==========================================
app.post('/api/orders/:id/cancel-reservation', async (req, res) => {
    const orderId = req.params.id;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [orders] = await connection.query('SELECT status FROM orders WHERE id = ? FOR UPDATE', [orderId]);
        if (orders.length > 0 && orders[0].status === 'pending') {
            const [items] = await connection.query(
                'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
                [orderId]
            );

            for (let item of items) {
                await connection.query(
                    'UPDATE products SET stock = stock + ? WHERE id = ?',
                    [item.quantity, item.product_id]
                );
            }

            await connection.query("UPDATE orders SET status = 'reject' WHERE id = ?", [orderId]);
        }

        await connection.commit();
        res.json({ success: true, message: "Reservasi berhasil dibatalkan dan stok dikembalikan." });
    } catch (error) {
        await connection.rollback();
        console.error("Error pembatalan reservasi:", error);
        res.status(500).json({ success: false, message: "Gagal membatalkan reservasi." });
    } finally {
        connection.release();
    }
});

// SEARCH ORDERS
app.get('/api/orders/search', async (req, res) => {
    try {
        const { phone, shop } = req.query;

        if (!phone || !shop) {
            return res.status(400).json({ success: false, message: "Parameter nomor HP dan shop wajib diisi." });
        }

        const shopId = await getShopIdBySlug(pool, shop);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });
        }

        const queryText = `
            SELECT 
                o.id AS order_id, o.customer_name, o.customer_phone, o.table_or_address, 
                o.total_price, o.tax_amount, o.status, o.created_at, o.payment_method,
                p.name AS nama_makanan, oi.quantity, oi.notes AS catatan_item, oi.subtotal
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE o.shop_id = ? 
              AND (o.customer_phone = ? OR o.customer_phone LIKE ?)
              AND o.status IN ('baru', 'proses')
            ORDER BY o.created_at DESC
        `;
        
        const searchLike = `%${phone}%`;
        const [rows] = await pool.query(queryText, [shopId, phone, searchLike]);
        
        const ordersGrouped = {};
        rows.forEach(row => {
            if (!ordersGrouped[row.order_id]) {
                ordersGrouped[row.order_id] = {
                    id: row.order_id,
                    customer_name: row.customer_name,
                    customer_phone: row.customer_phone,
                    table_or_address: row.table_or_address,
                    total_price: row.total_price,
                    tax_amount: row.tax_amount,
                    status: row.status,
                    created_at: row.created_at,
                    payment_method: row.payment_method,
                    items: []
                };
            }
            ordersGrouped[row.order_id].items.push({
                nama: row.nama_makanan,
                kuantitas: row.quantity,
                harga: row.subtotal / row.quantity,
                catatan: row.catatan_item
            });
        });

        res.json({
            success: true,
            data: Object.values(ordersGrouped)
        });
    } catch (error) {
        console.error("Error cari pesanan pembeli:", error);
        res.status(500).json({ success: false, message: "Gagal melacak pesanan Anda." });
    }
});

// SETTINGS SHOP
app.get('/api/shops/settings', verifikasiAksesWarung, async (req, res) => {
    try {
        const shopSlug = req.query.shop;
        if (!shopSlug) return res.status(400).json({ success: false, message: "Parameter shop wajib diisi." });

        const queryText = `
            SELECT id, shop_name, slug, is_open, show_cash_payment, bank_rekening_info, qris_image_url, default_stock_qty, has_tax, tax_percentage 
            FROM shops WHERE slug = ?
        `;
        const [rows] = await pool.query(queryText, [shopSlug]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });

        res.json({ success: true, data: rows[0] });
    } catch (error) {
        console.error("Error ambil setting toko:", error);
        res.status(500).json({ success: false, message: "Gagal mengambil data setting toko." });
    }
});

app.put('/api/shops/settings', verifikasiAksesWarung, cekMasaAktifSub, upload.single('qris_image'), async (req, res) => {
    try {
        const { shop, show_cash_payment, bank_rekening_info, default_stock_qty, has_tax, tax_percentage } = req.body;
        
        const shopId = await getShopIdBySlug(pool, shop);
        if (!shopId) return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });

        const [existing] = await pool.query('SELECT qris_image_url FROM shops WHERE id = ?', [shopId]);
        let urlQris = existing[0]?.qris_image_url || null;

        if (req.file) {
            const fileExtension = req.file.originalname.split('.').pop();
            const uniqueFilename = `qris-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${fileExtension}`;

            const uploadParams = {
                Bucket: process.env.R2_BUCKET_NAME,
                Key: uniqueFilename,
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            };

            await s3.send(new PutObjectCommand(uploadParams));
            urlQris = `${process.env.R2_PUBLIC_URL}/${uniqueFilename}`;
        }

        const queryUpdate = `
            UPDATE shops 
            SET show_cash_payment = ?, bank_rekening_info = ?, qris_image_url = ?, default_stock_qty = ?, has_tax = ?, tax_percentage = ?
            WHERE id = ?
        `;
        await pool.query(queryUpdate, [
            Number(show_cash_payment), 
            bank_rekening_info || '', 
            urlQris, 
            parseInt(default_stock_qty) || 20, 
            Number(has_tax), 
            parseFloat(tax_percentage) || 0.00,
            shopId
        ]);

        res.json({ success: true, message: "Pengaturan warung berhasil diperbarui!" });
    } catch (error) {
        console.error("Error update setting toko:", error);
        res.status(500).json({ success: false, message: "Gagal memperbarui pengaturan." });
    }
});

// REPORT EXCEL
app.get('/api/orders/report', verifikasiAksesWarung, async (req, res) => {
    try {
        const shopSlug = req.query.shop;
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, message: "Parameter startDate dan endDate wajib diisi." });
        }

        const shopId = await getShopIdBySlug(pool, shopSlug);
        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });
        }

        const formattedStart = `${startDate} 00:00:00`;
        const formattedEnd = `${endDate} 23:59:59`;

        const queryText = `
            SELECT 
                o.id, o.customer_name, o.customer_phone, o.table_or_address, 
                o.total_price, o.tax_amount, o.status, o.created_at, o.updated_at, o.payment_method,
                p.name AS nama_makanan, oi.quantity, oi.notes AS catatan_item, oi.subtotal
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE o.shop_id = ? 
              AND o.status = 'selesai'
              AND o.updated_at BETWEEN ? AND ?
            ORDER BY o.updated_at DESC;
        `;
        
        const [rows] = await pool.query(queryText, [shopId, formattedStart, formattedEnd]);
        
        const ordersGrouped = {};
        rows.forEach(row => {
            if (!ordersGrouped[row.id]) {
                ordersGrouped[row.id] = {
                    id: row.id,
                    customer_name: row.customer_name,
                    customer_phone: row.customer_phone,
                    table_or_address: row.table_or_address,
                    total_price: row.total_price,
                    tax_amount: row.tax_amount,
                    status: row.status,
                    created_at: row.created_at,
                    updated_at: row.updated_at, 
                    payment_method: row.payment_method,
                    items: []
                };
            }
            ordersGrouped[row.id].items.push({
                nama: row.nama_makanan,
                kuantitas: row.quantity,
                subtotal: row.subtotal,
                catatan: row.catatan_item
            });
        });

        res.json({
            success: true,
            data: Object.values(ordersGrouped)
        });
    } catch (error) {
        console.error("Error ambil laporan transaksi:", error);
        res.status(500).json({ success: false, message: "Gagal memproses laporan dari database." });
    }
});

// SUBSCRIPTION TOKO
app.get('/api/shops/subscription', async (req, res) => {
    try {
        const shopSlug = req.query.shop;
        
        if (!shopSlug) {
            return res.status(400).json({ success: false, message: "Parameter query warung (shop) wajib diisi." });
        }

        const queryText = `
            SELECT s.id, s.subscription_status, s.subscription_until, p.name AS package_name
            FROM shops s
            LEFT JOIN packages p ON s.package_id = p.id
            WHERE s.slug = ?
        `;
        const [rows] = await pool.query(queryText, [shopSlug]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });
        }

        const shop = rows[0];

        if (!shop.subscription_until) {
            return res.json({
                success: true,
                data: {
                    package_name: shop.package_name || 'Tidak Ada Paket',
                    subscription_status: shop.subscription_status || 'expired',
                    remaining_days: 0,
                    is_toleransi: false,
                    is_expired: true
                }
            });
        }

        const sekarang = new Date();
        const subUntil = new Date(shop.subscription_until);
        
        const batasToleransi = new Date(subUntil);
        batasToleransi.setDate(batasToleransi.getDate() + 1);

        const diffTime = subUntil - sekarang;
        const remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        const isToleransi = sekarang > subUntil && sekarang <= batasToleransi;
        const isExpiredTotal = sekarang > batasToleransi;

        return res.json({
            success: true,
            data: {
                package_name: shop.package_name || 'Trial/Basic',
                subscription_status: shop.subscription_status,
                remaining_days: remainingDays,
                is_toleransi: isToleransi,
                is_expired: isExpiredTotal
            }
        });

    } catch (error) {
        console.error("Error cek status langganan:", error);
        return res.status(500).json({ success: false, message: "Terjadi kesalahan server: " + error.message });
    }
});

app.post('/api/shops/subscribe', upload.single('payment_proof'), async (req, res) => {
    try {
        const { shop, package_id, billing_cycle } = req.body;
        const shopId = await getShopIdBySlug(pool, shop);

        if (!shopId) {
            return res.status(404).json({ success: false, message: "Warung tidak ditemukan." });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: "Bukti transfer pembayaran paket wajib diunggah." });
        }

        const [pkgRows] = await pool.query('SELECT name, price_monthly, price_yearly FROM packages WHERE id = ?', [package_id]);
        if (pkgRows.length === 0) {
            return res.status(400).json({ success: false, message: "Paket tidak valid." });
        }

        const pkg = pkgRows[0];
        const cycle = billing_cycle === 'yearly' ? 'yearly' : 'monthly';
        const amount = cycle === 'yearly' ? pkg.price_yearly : pkg.price_monthly;

        const fileExtension = req.file.originalname.split('.').pop();
        const uniqueFilename = `sub-proof-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${fileExtension}`;

        const uploadParams = {
            Bucket: process.env.R2_BUCKET_NAME,
            Key: uniqueFilename,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        };

        await s3.send(new PutObjectCommand(uploadParams));
        const urlBukti = `${process.env.R2_PUBLIC_URL}/${uniqueFilename}`;

        const startDateStr = new Date().toISOString().split('T')[0];
        await pool.query(
            `INSERT INTO subscriptions (shop_id, package_id, package_name, amount, start_date, status, billing_cycle, payment_proof_url)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [shopId, package_id, `Perpanjangan ${pkg.name} (${cycle.toUpperCase()})`, amount, startDateStr, cycle, urlBukti]
        );

        res.json({
            success: true,
            message: "Konfirmasi pembayaran paket berhasil dikirim! Menunggu verifikasi admin."
        });

    } catch (error) {
        console.error("Error submit bayar paket:", error);
        res.status(500).json({ success: false, message: "Gagal memproses konfirmasi pembayaran: " + error.message });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server berjalan di port ${PORT}`);
});