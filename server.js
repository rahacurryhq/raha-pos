// THE RAHA CLOUD POS - v4.0
// Full Dine-in + Takeaway + Delivery
// Course-based menu, Table management, QR self-order
// Irish VAT compliance, Admin controls

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] },
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = process.env.DATABASE_PATH || './raha_pos.db';
let db;
try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('✓ Database connected');
} catch (err) {
    console.error('❌ Database failed:', err);
    process.exit(1);
}

const sessions = new Map();
const SESSION_TIMEOUT = 8 * 60 * 60 * 1000;
const loginAttempts = new Map();

function checkRateLimit(ip) {
    const now = Date.now();
    const window = 15 * 60 * 1000;
    if (!loginAttempts.has(ip)) loginAttempts.set(ip, []);
    const attempts = loginAttempts.get(ip).filter(t => now - t < window);
    loginAttempts.set(ip, attempts);
    if (attempts.length >= 10) return false;
    attempts.push(now);
    return true;
}

function hashPin(pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(pin, salt, 10000, 64, 'sha512').toString('hex');
    return { hash, salt };
}

const MASTER_PASSWORD = process.env.MASTER_PASSWORD || 'Raha@M@ster#2026!';
function verifyMaster(password) {
    return password === MASTER_PASSWORD;
}

function verifyPin(pin, hash, salt) {
    if (!pin || !hash || !salt) return false;
    return crypto.pbkdf2Sync(pin, salt, 10000, 64, 'sha512').toString('hex') === hash;
}

function getNextOrderNumber() {
    const update = db.prepare('UPDATE order_sequence SET current_number = current_number + 1 WHERE id = 1');
    const select = db.prepare('SELECT current_number FROM order_sequence WHERE id = 1');
    db.transaction(() => update.run())();
    return select.get().current_number;
}

function getVATRateForDate(date) {
    const rates = db.prepare(`
        SELECT vat_rate FROM vat_periods
        WHERE date(start_date) <= date(?)
        AND (end_date IS NULL OR date(end_date) >= date(?))
        ORDER BY start_date DESC LIMIT 1
    `).get(date, date);
    return rates ? rates.vat_rate : 13.5;
}

function calculateVAT(total, vatRate) {
    const vatAmount = total / (1 + vatRate / 100) * (vatRate / 100);
    return {
        vat_amount: Math.round(vatAmount * 100) / 100,
        net_amount: Math.round((total - vatAmount) * 100) / 100
    };
}

function autoSaveCustomer(order) {
    try {
        if (!order.customer_name || order.customer_name === 'Guest') return;
        if (!order.customer_phone) return;
        const existing = db.prepare("SELECT id FROM customers WHERE phone = ? AND deleted = 0").get(order.customer_phone);
        if (existing) {
            db.prepare("UPDATE customers SET name=?, total_orders=total_orders+1, total_spent=total_spent+?, last_order_date=datetime('now'), updated_at=datetime('now') WHERE id=?")
                .run(order.customer_name, order.total || 0, existing.id);
        } else {
            db.prepare("INSERT INTO customers (name, phone, address, total_orders, total_spent, last_order_date) VALUES (?,?,?,1,?,datetime('now'))")
                .run(order.customer_name, order.customer_phone, order.customer_address || '', order.total || 0);
        }
    } catch(e) { console.log('Auto-save customer skipped:', e.message); }
}

// ============= DATABASE INIT =============
function initDatabase() {
    try {
        // Run migrations FIRST before anything else
        // This adds new columns to existing DB before indexes/triggers reference them
        try { db.exec("ALTER TABLE orders ADD COLUMN table_number INTEGER DEFAULT NULL"); } catch(e) {}
        try { db.exec("ALTER TABLE orders ADD COLUMN covers INTEGER DEFAULT 1"); } catch(e) {}
        try { db.exec("ALTER TABLE orders ADD COLUMN course_status TEXT DEFAULT '{}'"); } catch(e) {}
        try { db.exec("ALTER TABLE menu_items ADD COLUMN course TEXT NOT NULL DEFAULT 'mains'"); } catch(e) {}
        try { db.exec("ALTER TABLE menu_items ADD COLUMN vat_rate REAL DEFAULT NULL"); } catch(e) {}
        // CRM fields
        try { db.exec("ALTER TABLE customers ADD COLUMN birthday TEXT"); } catch(e) {}
        try { db.exec("ALTER TABLE customers ADD COLUMN vip INTEGER DEFAULT 0"); } catch(e) {}
        try { db.exec("ALTER TABLE customers ADD COLUMN loyalty_points INTEGER DEFAULT 0"); } catch(e) {}
        try { db.exec("ALTER TABLE customers ADD COLUMN staff_notes TEXT DEFAULT ''"); } catch(e) {}
        try { db.exec("ALTER TABLE customers ADD COLUMN preferences TEXT DEFAULT ''"); } catch(e) {}
        try { db.exec("ALTER TABLE customers ADD COLUMN marketing_opt_in INTEGER DEFAULT 1"); } catch(e) {}
        try { db.exec("ALTER TABLE customers ADD COLUMN email TEXT DEFAULT ''"); } catch(e) {}

        db.exec(`
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_number INTEGER NOT NULL UNIQUE,
                timestamp TEXT NOT NULL,
                customer_name TEXT NOT NULL DEFAULT 'Guest',
                customer_phone TEXT,
                customer_address TEXT,
                items TEXT NOT NULL,
                subtotal REAL NOT NULL DEFAULT 0,
                delivery_charge REAL DEFAULT 0,
                vat_rate REAL NOT NULL DEFAULT 13.5,
                vat_amount REAL NOT NULL DEFAULT 0,
                net_amount REAL NOT NULL DEFAULT 0,
                total REAL NOT NULL DEFAULT 0,
                payment_type TEXT NOT NULL DEFAULT 'cash',
                mode TEXT NOT NULL DEFAULT 'collection',
                table_number INTEGER DEFAULT NULL,
                covers INTEGER DEFAULT 1,
                status TEXT DEFAULT 'pending',
                course_status TEXT DEFAULT '{}',
                created_by TEXT NOT NULL DEFAULT 'staff',
                kitchen_received_time TEXT,
                cooking_started_time TEXT,
                ready_time TEXT,
                completed_time TEXT,
                cancelled_time TEXT,
                notes TEXT,
                special_instructions TEXT,
                allergies TEXT,
                deleted INTEGER DEFAULT 0,
                deleted_by TEXT,
                deleted_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS tables (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number INTEGER NOT NULL UNIQUE,
                name TEXT,
                capacity INTEGER DEFAULT 4,
                status TEXT DEFAULT 'available',
                current_order_id INTEGER,
                opened_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS vat_periods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                start_date TEXT NOT NULL,
                end_date TEXT,
                vat_rate REAL NOT NULL,
                description TEXT,
                created_by TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS menu_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL,
                course TEXT NOT NULL DEFAULT 'mains',
                price REAL NOT NULL DEFAULT 0,
                vat_rate REAL DEFAULT NULL,
                description TEXT,
                allergens TEXT,
                available INTEGER DEFAULT 1,
                display_order INTEGER DEFAULT 0,
                deleted INTEGER DEFAULT 0,
                deleted_by TEXT,
                deleted_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT UNIQUE,
                email TEXT,
                address TEXT,
                delivery_notes TEXT,
                allergen_info TEXT,
                total_orders INTEGER DEFAULT 0,
                total_spent REAL DEFAULT 0,
                last_order_date TEXT,
                deleted INTEGER DEFAULT 0,
                deleted_by TEXT,
                deleted_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                pin_hash TEXT NOT NULL UNIQUE,
                pin_salt TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin','manager','chef','front')),
                active INTEGER DEFAULT 1,
                last_login TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS staff_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                staff_name TEXT NOT NULL,
                action TEXT NOT NULL,
                timestamp TEXT NOT NULL DEFAULT (datetime('now')),
                order_id INTEGER,
                details TEXT,
                ip_address TEXT
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS order_sequence (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                current_number INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
            CREATE INDEX IF NOT EXISTS idx_orders_timestamp ON orders(timestamp);
            CREATE INDEX IF NOT EXISTS idx_orders_deleted ON orders(deleted);
            CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_number);
            CREATE INDEX IF NOT EXISTS idx_menu_course ON menu_items(course);

            CREATE TRIGGER IF NOT EXISTS update_orders_timestamp
            AFTER UPDATE ON orders
            BEGIN UPDATE orders SET updated_at = datetime('now') WHERE id = NEW.id; END;

            CREATE TRIGGER IF NOT EXISTS update_customers_timestamp
            AFTER UPDATE ON customers
            BEGIN UPDATE customers SET updated_at = datetime('now') WHERE id = NEW.id; END;
        `);

        db.prepare('INSERT OR IGNORE INTO order_sequence (id, current_number) VALUES (1, 0)').run();

        // Init tables 1-10
        for (let i = 1; i <= 10; i++) {
            db.prepare('INSERT OR IGNORE INTO tables (number, name, capacity) VALUES (?, ?, ?)').run(i, `Table ${i}`, 4);
        }

        const vatCount = db.prepare('SELECT COUNT(*) as count FROM vat_periods').get();
        if (vatCount.count === 0) {
            db.prepare(`INSERT INTO vat_periods (start_date, end_date, vat_rate, description) VALUES
                ('2020-01-01', '2026-06-30', 13.5, 'Standard Irish VAT rate'),
                ('2026-07-01', NULL, 9.0, 'Reduced rate from July 2026')`).run();
        }

        const settings = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
        settings.run('restaurant_name', 'The RAHA');
        settings.run('delivery_charge', '3.50');
        settings.run('currency', 'EUR');
        settings.run('delete_password', process.env.DELETE_PASSWORD || 'Raha@Del#2026!');
        settings.run('kiosk_unlock_password', process.env.KIOSK_PASSWORD || 'Raha@Ki0sk#26!');

        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
        if (userCount.count === 0) insertDefaultUsers();

        // Menu versioning — if menu version is not v4 (Raha real menu), reseed
        const menuVersion = db.prepare("SELECT value FROM settings WHERE key='menu_version'").get();
        if (!menuVersion || menuVersion.value !== 'v4_raha') {
            console.log('🔄 Updating menu to Raha v4 (real menu)...');
            db.prepare('DELETE FROM menu_items').run(); // wipe all old menu items completely
            insertFullMenu();
            db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('menu_version','v4_raha',datetime('now'))").run();
        }

        console.log('✓ Database initialized');
        return true;
    } catch (err) {
        console.error('❌ Database init failed:', err);
        return false;
    }
}

function insertDefaultUsers() {
    const users = [
        { name: 'Admin', pin: '9999', role: 'admin' },
        { name: 'Manager', pin: '2222', role: 'manager' },
        { name: 'Chef', pin: '1111', role: 'chef' },
        { name: 'Front Staff', pin: '3333', role: 'front' }
    ];
    const insert = db.prepare('INSERT INTO users (name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?)');
    users.forEach(u => {
        const { hash, salt } = hashPin(u.pin);
        insert.run(u.name, hash, salt, u.role);
    });
    console.log('✓ Users created');
}

function insertFullMenu() {
    const menu = [
        // ===== APPETISERS - STARTERS =====
        { name: 'Bhelupuri', course: 'starters', cat: 'Street Classics', price: 6.95, desc: 'Crispy puffed rice tossed with sweet tamarind chutney and spicy green chutney. A popular appetiser from Mumbai.', allergens: 'Gluten,Peanuts,Sesame' },
        { name: 'Onion Bhaji', course: 'starters', cat: 'Street Classics', price: 6.95, desc: 'Chopped onions battered in gram flour and spices, deep fried until golden crisp. Served with homemade chutney.', allergens: 'Gluten' },
        { name: 'Aloo Tikki Chaat', course: 'starters', cat: 'Street Classics', price: 7.55, desc: 'Crispy Irish potato patties made with boiled potatoes, split chickpea lentils, and ground spices.', allergens: 'Gluten,Egg,Peanuts,Milk,Mustard' },
        { name: 'Punjabi Samosa', course: 'starters', cat: 'Street Classics', price: 7.55, desc: 'Triangular-shaped flaky pastry stuffed with Irish potatoes, peas and herbs.', allergens: 'Gluten,Egg,Milk' },
        { name: 'Beetroot Cheese Balls', course: 'starters', cat: 'Street Classics', price: 8.55, desc: 'Crispy cheesy beetroot and potato balls seasoned with spices, served with cashew, coconut and saffron sauce.', allergens: 'Gluten,Egg,Milk,Cashew' },
        { name: 'Murgh Malai Tikka', course: 'starters', cat: "Chef's Signatures", price: 8.95, desc: 'Tender creamy boneless chicken marinated in yogurt and spices, grilled to perfection in a tandoor.', allergens: 'Egg,Milk,Cashew' },
        { name: 'Trio Chicken Tikka Basket', course: 'starters', cat: "Chef's Signatures", price: 9.95, desc: 'Three chicken marinades: bold turmeric & chili, on-the-bone tandoori tikka, and rich yogurt & cream — all grilled to perfection.', allergens: 'Gluten,Egg,Milk,Cashew' },
        { name: 'Seekh Kebab', course: 'starters', cat: 'From the Tandoor', price: 9.50, desc: 'Minced lamb mixed with spices, wrapped around a skewer and grilled in tandoor until melt in mouth.', allergens: 'Egg,Milk' },
        { name: 'Amritsari Fish Pakora', course: 'starters', cat: 'Seafood', price: 9.95, desc: 'Lightly battered fish fry seasoned with gram flour, spices, ginger and garlic paste. A crunchy refreshing treat.', allergens: 'Gluten,Fish,Egg' },
        { name: 'Lehsuni Jhinga', course: 'starters', cat: 'Seafood', price: 12.95, desc: 'Grilled king prawns prepared in a tangy marination of chopped garlic, lime juice and spices.', allergens: 'Crustaceans,Egg,Peanuts,Milk,Mustard' },
        { name: 'Raha Vegetarian Platter (for 2)', course: 'starters', cat: 'Sharing Platters', price: 14.95, desc: 'Onion Bhaji, Vegetable Samosa, Aloo Tikki and Beetroot Cheese Balls. Perfect for sharing.', allergens: 'Gluten,Egg,Milk,Mustard' },
        { name: 'Raha Special Platter (for 2)', course: 'starters', cat: 'Sharing Platters', price: 16.95, desc: 'Chicken tikkas, Seekh Kebab, Onion Bhaji & Aloo Tikki. A crowd favourite.', allergens: 'Crustaceans,Egg,Milk,Mustard' },

        // ===== MAINS - CHEF SPECIALS =====
        { name: 'Raha Butter Chicken', course: 'mains', cat: "Chef's Special", price: 21.95, desc: 'A comforting Delhi delicacy. Chicken marinated in yogurt and spices cooked in a creamy tomato-based sauce.', allergens: 'Milk,Cashew' },
        { name: 'Chicken Jalfrezi', course: 'mains', cat: "Chef's Special", price: 21.95, desc: 'Stir-fried marinated chicken with bell peppers, onions, tomatoes, and green chilies.', allergens: 'Milk,Cashew' },
        { name: 'Lamb Shank', course: 'mains', cat: "Chef's Special", price: 25.95, desc: 'Succulent slow-cooked lamb shank in tomato sauce with ginger, garlic and special garam masala. Mughlai cuisine.', allergens: 'Milk' },
        { name: 'Raan E Sikandari', course: 'mains', cat: "Chef's Special", price: 22.95, desc: '"Feast from the East" — Slow roasted Irish lamb marinated overnight, served in an aromatic sauce.', allergens: 'Milk' },
        { name: 'Mango Chilli Prawns', course: 'mains', cat: "Chef's Special", price: 22.95, desc: 'King prawns cooked with crushed chillies, coconut & spiced mango marmalade.', allergens: 'Crustaceans,Milk,Cashew' },
        { name: 'Goan Prawn / Fish Curry', course: 'mains', cat: "Chef's Special", price: 23.95, desc: 'Aromatic king prawn or tilapia fish curry with tamarind, spices, garlic, ginger, onion, tomato and coconut.', allergens: 'Crustaceans,Fish,Milk,Mustard' },
        { name: 'Jhinga Moilee', course: 'mains', cat: "Chef's Special", price: 23.95, desc: 'Fragrant, rich and creamy curry tempered with coconut milk and packed with succulent king prawns.', allergens: 'Crustaceans,Milk,Mustard' },

        // ===== MAINS - ALL TIME FAVOURITES =====
        { name: 'Raha Korma (Veg)', course: 'mains', cat: 'All-Time Favourites', price: 18.95, desc: 'Cooked in creamy cashew nuts with saffron & very mild spices.', allergens: 'Milk,Cashew' },
        { name: 'Raha Korma (Chicken)', course: 'mains', cat: 'All-Time Favourites', price: 20.95, desc: 'Chicken cooked in creamy cashew nuts with saffron & very mild spices.', allergens: 'Milk,Cashew' },
        { name: 'Raha Korma (Lamb)', course: 'mains', cat: 'All-Time Favourites', price: 22.95, desc: 'Irish lamb cooked in creamy cashew nuts with saffron & very mild spices.', allergens: 'Milk,Cashew' },
        { name: 'Raha Korma (Prawns)', course: 'mains', cat: 'All-Time Favourites', price: 22.95, desc: 'King prawns cooked in creamy cashew nuts with saffron & very mild spices.', allergens: 'Crustaceans,Milk,Cashew' },
        { name: 'Tikka Masala (Veg)', course: 'mains', cat: 'All-Time Favourites', price: 18.95, desc: 'Tomato and cream-based sauce with a lot of spices. Slightly spicy and earthy.', allergens: 'Milk,Cashew' },
        { name: 'Tikka Masala (Chicken)', course: 'mains', cat: 'All-Time Favourites', price: 20.95, desc: 'Chicken in tomato and cream-based sauce with a lot of spices. Slightly spicy and earthy.', allergens: 'Milk,Cashew' },
        { name: 'Tikka Masala (Lamb)', course: 'mains', cat: 'All-Time Favourites', price: 22.95, desc: 'Irish lamb in tomato and cream-based sauce with a lot of spices. Slightly spicy and earthy.', allergens: 'Milk,Cashew' },
        { name: 'Tikka Masala (Prawns)', course: 'mains', cat: 'All-Time Favourites', price: 22.95, desc: 'King prawns in tomato and cream-based sauce with a lot of spices.', allergens: 'Crustaceans,Milk,Cashew' },
        { name: 'Bhuna (Chicken)', course: 'mains', cat: 'All-Time Favourites', price: 20.95, desc: "Grandmas Bhuna Pot — Bengali speciality, spices fried at high temperature then meat simmered in its own juices.", allergens: 'Milk,Cashew' },
        { name: 'Bhuna (Lamb)', course: 'mains', cat: 'All-Time Favourites', price: 22.95, desc: "Grandmas Bhuna Pot — Bengali speciality with Irish lamb, spices fried at high temperature.", allergens: 'Milk,Cashew' },
        { name: 'Saag (Chicken)', course: 'mains', cat: 'All-Time Favourites', price: 20.95, desc: 'Mixture of leafy greens — spinach, mustard, methi leaves — cooked in mild spices with chicken.', allergens: 'Milk,Cashew,Mustard' },
        { name: 'Saag (Lamb)', course: 'mains', cat: 'All-Time Favourites', price: 22.95, desc: 'Mixture of leafy greens — spinach, mustard, methi leaves — cooked in mild spices with Irish lamb.', allergens: 'Milk,Cashew,Mustard' },
        { name: 'Kadhai (Chicken)', course: 'mains', cat: 'All-Time Favourites', price: 20.95, desc: 'Smoky and slightly charred flavour. Recommended with chicken. Freshly ground spices.', allergens: 'Milk,Cashew' },
        { name: 'Rogan Josh (Lamb)', course: 'mains', cat: 'All-Time Favourites', price: 22.95, desc: 'Rich curry flavoured with clarified butter and aromatic spices. Highly recommended with lamb.', allergens: 'Milk' },
        { name: 'Garlic Chilli (Chicken)', course: 'mains', cat: 'All-Time Favourites', price: 20.95, desc: 'Sauce made with fresh peppers and garlic. Can be mild or spicy just the way you want it.', allergens: 'Milk,Cashew' },
        { name: 'Madras (Chicken)', course: 'mains', cat: 'All-Time Favourites', price: 20.95, desc: 'Rich and flavourful curry sauce from Chennai. Coriander, cumin, turmeric and chilli powder.', allergens: 'Milk,Cashew,Mustard' },
        { name: 'Vindaloo (Chicken)', course: 'mains', cat: 'All-Time Favourites', price: 20.95, desc: 'Spicy, tangy sauce from Goa. The spiciest option at Raha. Spices with coconut and red chilies.', allergens: 'Milk,Cashew,Mustard' },

        // ===== MAINS - VEGETARIAN =====
        { name: 'Mix Vegetable Curry', course: 'mains', cat: 'Vegetarian', price: 17.95, desc: 'Colourful combination of various vegetables cooked in a rich and flavourful curry sauce.', allergens: 'Milk,Cashew' },
        { name: 'Malai Kofta', course: 'mains', cat: 'Vegetarian', price: 19.95, desc: 'Fried balls of potato, cheese, and mixed veggies in a creamy sauce of blended nuts, onions, tomatoes and fragrant spices.', allergens: 'Gluten,Milk,Cashew' },
        { name: 'Chana Masala', course: 'mains', cat: 'Vegetarian', price: 18.95, desc: 'Chickpeas cooked in a tangy and spicy sauce with ginger, garlic, green chilies, and a mix of Indian spices.', allergens: 'Milk,Cashew' },
        { name: 'Saag Paneer', course: 'mains', cat: 'Vegetarian', price: 20.95, desc: 'Blended spinach with spices, onions, tomatoes, ginger, and garlic — a velvety smooth sauce with paneer.', allergens: 'Milk,Cashew,Mustard' },
        { name: 'Kadhai Paneer', course: 'mains', cat: 'Vegetarian', price: 20.95, desc: 'Cottage cheese sautéed with bell peppers, onions, and tomatoes in a rich aromatic gravy. Bold and smoky.', allergens: 'Milk,Cashew,Mustard' },
        { name: 'Daal Tarka', course: 'mains', cat: 'Vegetarian', price: 17.95, desc: 'Comforting lentil dish made from a combination of lentils, cooked with tomatoes, onions, and a blend of spices.', allergens: 'Milk' },
        { name: 'Bhindi Masala', course: 'mains', cat: 'Vegetarian', price: 18.95, desc: 'Okra sautéed in a spicy blend of onions, tomatoes, and Indian spices.', allergens: 'Milk,Cashew' },

        // ===== MAINS - BIRYANI =====
        { name: 'Vegetable Biryani', course: 'mains', cat: 'Biryani', price: 19.95, desc: 'Long-grain basmati rice with aromatic spices — saffron, mint and dried herbs — with vegetables. Chef recommends adding raita.', allergens: 'Milk,Cashew' },
        { name: 'Chicken Biryani', course: 'mains', cat: 'Biryani', price: 21.95, desc: 'Long-grain basmati rice with aromatic spices — saffron, mint and dried herbs — with chicken. Chef recommends adding raita.', allergens: 'Milk,Cashew' },
        { name: 'Lamb Biryani', course: 'mains', cat: 'Biryani', price: 22.95, desc: 'Long-grain basmati rice with aromatic spices — saffron, mint and dried herbs — with Irish lamb. Chef recommends adding raita.', allergens: 'Milk,Cashew' },
        { name: 'Prawn Biryani', course: 'mains', cat: 'Biryani', price: 22.95, desc: 'Long-grain basmati rice with aromatic spices — saffron, mint and dried herbs — with king prawns.', allergens: 'Crustaceans,Milk,Cashew' },

        // ===== MAINS - TANDOOR =====
        { name: 'Paneer Tikka Achari', course: 'mains', cat: 'Tandoor Speciality', price: 20.95, desc: 'Homemade Indian cottage cheese with pickle spices grilled in a traditional clay oven. Served with curry sauce.', allergens: 'Egg,Milk,Cashew,Mustard' },
        { name: 'Tandoori Chicken', course: 'mains', cat: 'Tandoor Speciality', price: 20.95, desc: 'Chicken on the bone marinated in yogurt & spices, cooked on a slow fire in tandoor. Served with curry sauce.', allergens: 'Egg,Milk,Cashew,Mustard' },
        { name: 'Shaslik Chicken', course: 'mains', cat: 'Tandoor Speciality', price: 20.95, desc: 'Chicken tikka sautéed with onions & peppers. Served with curry sauce.', allergens: 'Egg,Milk,Cashew,Mustard' },

        // ===== SIDES =====
        { name: 'Aloo Jeera', course: 'mains', cat: 'Sides', price: 8.95, desc: 'Irish potatoes and cumin seeds sautéed with turmeric, coriander, and chilli powder.', allergens: 'Milk' },
        { name: 'Bombay Aloo', course: 'mains', cat: 'Sides', price: 9.95, desc: 'Boiled potatoes sautéed with onions, tomatoes and a blend of Indian spices. From the streets of Mumbai.', allergens: 'Milk,Cashew' },
        { name: 'Aloo Gobhi', course: 'mains', cat: 'Sides', price: 9.95, desc: 'Classic North Indian dish with potatoes and cauliflower with mild spices.', allergens: 'Milk,Cashew' },
        { name: 'Honey Chilli Chips', course: 'mains', cat: 'Sides', price: 7.95, desc: 'Crispy chips tossed in sweet and spicy honey chilli sauce, garnished with sesame seeds and spring onions.', allergens: 'Milk,Mustard,Sesame' },
        { name: 'Chips', course: 'mains', cat: 'Sides', price: 4.95, desc: 'Fresh cut chips.', allergens: 'None' },
        { name: 'Mixed Raita', course: 'mains', cat: 'Sides', price: 4.95, desc: "Chef's recommendation — perfect with biryani.", allergens: 'Milk' },
        { name: 'Pappadums & Dips', course: 'mains', cat: 'Sides', price: 3.50, desc: 'Served with mango, coconut and tomato dips.', allergens: 'Gluten' },
        { name: 'Mixed Salad', course: 'mains', cat: 'Sides', price: 5.50, desc: 'Fresh mixed salad.', allergens: 'None' },

        // ===== RICE =====
        { name: 'Steamed Rice', course: 'mains', cat: 'Rice', price: 3.00, desc: 'Plain basmati rice.', allergens: 'None' },
        { name: 'Pilau Rice', course: 'mains', cat: 'Rice', price: 3.50, desc: 'Basmati rice flavoured with saffron and cardamom.', allergens: 'None' },
        { name: 'Garden Rice', course: 'mains', cat: 'Rice', price: 4.50, desc: 'Flavoured with fresh coriander, mint and spices.', allergens: 'None' },
        { name: 'Lemon Rice', course: 'mains', cat: 'Rice', price: 4.50, desc: 'Rice cooked in lemon pulp and mustard seed.', allergens: 'Mustard' },
        { name: 'Egg Fried Rice', course: 'mains', cat: 'Rice', price: 4.50, desc: 'With eggs, spring onions and fresh coriander.', allergens: 'Egg,Soya' },

        // ===== BREAD =====
        { name: 'Plain Naan', course: 'mains', cat: 'Naan Bread', price: 3.50, desc: 'Traditional tandoor baked naan.', allergens: 'Gluten,Egg,Milk' },
        { name: 'Garlic Naan', course: 'mains', cat: 'Naan Bread', price: 4.50, desc: 'Garlic butter naan, baked in tandoor.', allergens: 'Gluten,Egg,Milk' },
        { name: 'Garlic Coriander Naan', course: 'mains', cat: 'Naan Bread', price: 4.50, desc: 'Garlic and fresh coriander naan.', allergens: 'Gluten,Egg,Milk' },
        { name: 'Garlic Chilli Naan', course: 'mains', cat: 'Naan Bread', price: 4.75, desc: 'Garlic and chilli naan with a kick.', allergens: 'Gluten,Egg,Milk' },
        { name: 'Peshwari Naan', course: 'mains', cat: 'Naan Bread', price: 5.50, desc: 'Sweet stuffing of coconut, cashew nut and raisins.', allergens: 'Gluten,Egg,Milk,Cashew' },
        { name: 'Keema Naan', course: 'mains', cat: 'Naan Bread', price: 5.95, desc: 'Stuffed with minced lamb.', allergens: 'Gluten,Egg,Milk' },
        { name: 'Whole Wheat Roti', course: 'mains', cat: 'Naan Bread', price: 3.00, desc: 'Whole wheat flatbread.', allergens: 'Gluten,Milk' },

        // ===== KIDS MENU =====
        { name: 'Chicken Nuggets & Chips', course: 'mains', cat: "Kids Menu", price: 11.95, desc: 'Kids chicken nuggets with chips.', allergens: 'Gluten,Egg,Milk' },
        { name: 'Kids Tikka Masala / Korma', course: 'mains', cat: "Kids Menu", price: 12.95, desc: 'Kids portion of chicken tikka masala or korma.', allergens: 'Milk,Cashew' },

        // ===== DESSERTS =====
        { name: 'Gulab Jamun', course: 'desserts', cat: 'Desserts', price: 6.95, desc: 'Deep-fried sweetened dough balls soaked in rose water, sugar and cardamom syrup.', allergens: 'Gluten,Milk,Pistachio' },
        { name: 'Death By Chocolate Cake', course: 'desserts', cat: 'Desserts', price: 7.95, desc: 'Layers of rich velvety chocolate cake, decadent ganache, and luscious frosting. A chocoholic dream!', allergens: 'Gluten,Egg,Milk' },
        { name: 'Cheesecake of the Day', course: 'desserts', cat: 'Desserts', price: 7.95, desc: 'Creamy, zesty cheesecake on a buttery crust, served with ice cream. Ask your server for todays flavour.', allergens: 'Gluten,Egg,Milk' },
        { name: 'Pistachio Kulfi', course: 'desserts', cat: 'Desserts', price: 6.95, desc: 'Rich creamy Indian frozen dessert made with milk and finely ground pistachios, infused with cardamom.', allergens: 'Milk,Pistachio' },
        { name: 'Mango Kulfi', course: 'desserts', cat: 'Desserts', price: 6.95, desc: 'Rich creamy Indian frozen dessert made with refreshing mango, infused with cardamom.', allergens: 'Milk,Pistachio' },
        { name: 'Chocolate Brownie', course: 'desserts', cat: 'Desserts', price: 7.95, desc: 'Rich and fudgy chocolate dessert with a soft chewy centre. Served with vanilla ice cream.', allergens: 'Gluten,Egg,Milk' },
        { name: 'Affogato', course: 'desserts', cat: 'Desserts', price: 6.95, desc: 'Smooth vanilla ice cream topped with hot espresso, garnished with caramel toffee pieces.', allergens: 'Milk' },
        { name: 'Carrot Cake', course: 'desserts', cat: 'Desserts', price: 7.95, desc: 'Moist carrot cake with warm spices and vanilla, topped with rich cream cheese frosting.', allergens: 'Gluten,Egg,Milk,Walnut' },

        // ===== DRINKS =====
        // Cocktails
        { name: 'Mojito', course: 'drinks', cat: 'Cocktails', price: 7.00, desc: 'Fresh lime, mint leaves, and dry Prosecco — a refreshing effervescent twist on the classic mojito.', allergens: 'None' },
        { name: 'Aperol Spritz', course: 'drinks', cat: 'Cocktails', price: 7.00, desc: 'Aperol, dry Prosecco, and soda, garnished with orange. Crisp and vibrant Italian cocktail.', allergens: 'None' },
        { name: 'Bellini', course: 'drinks', cat: 'Cocktails', price: 7.00, desc: 'Delightful blend of Prosecco and peach purée. Refreshing, fruity, and perfect for any celebration.', allergens: 'None' },
        { name: 'Espresso Martini', course: 'drinks', cat: 'Cocktails', price: 7.00, desc: 'Bold and smooth mix of vodka, coffee liqueur, and freshly brewed espresso. For coffee lovers.', allergens: 'None' },
        { name: 'Passiontini', course: 'drinks', cat: 'Cocktails', price: 7.00, desc: 'Tropical passion fruit, zesty lime, and simple syrup, topped with sparkling prosecco and soda.', allergens: 'None' },
        { name: 'RAHA Bliss', course: 'drinks', cat: 'Cocktails', price: 7.00, desc: 'Blue Curaçao and sparkling prosecco — a mesmerizing blue hue cocktail.', allergens: 'None' },
        { name: 'Baby Guinness Shot', course: 'drinks', cat: 'Cocktails', price: 5.50, desc: 'The perfect sweet finish after a hearty meal. Looks like a pint, goes down like a dream!', allergens: 'None' },
        // Beer
        { name: 'Premium Cobra Draught', course: 'drinks', cat: 'Beer', price: 6.50, desc: 'Premium Indian lager draught.', allergens: 'Gluten' },
        { name: 'Cobra Zero', course: 'drinks', cat: 'Beer', price: 4.99, desc: 'Alcohol-free Indian lager.', allergens: 'Gluten' },
        // Wine - Champagne & Sparkling
        { name: 'Gremillet Champagne (bottle)', course: 'drinks', cat: 'Champagne & Sparkling', price: 69.95, desc: 'Pinot Noir/Chardonnay. Aromas of buttered toast, very fresh and long in taste. Organic, France.', allergens: 'Sulphites' },
        { name: 'Dogarina Prosecco (glass)', course: 'drinks', cat: 'Champagne & Sparkling', price: 10.95, desc: 'Straw colour with charming aromas of apples and pears. Bright, fresh and fruity.', allergens: 'Sulphites' },
        { name: 'Dogarina Prosecco (bottle)', course: 'drinks', cat: 'Champagne & Sparkling', price: 35.95, desc: 'Straw colour with charming aromas of apples and pears. Bright, fresh and fruity.', allergens: 'Sulphites' },
        { name: 'Glera Prosecco (bottle)', course: 'drinks', cat: 'Champagne & Sparkling', price: 45.95, desc: 'Prosecco DOC Spumante, Italy (Vegan). Fresh orchard fruit, wild flower aromas, fine long-lasting bubbles.', allergens: 'Sulphites' },
        { name: 'Villa Conchi Cava (bottle)', course: 'drinks', cat: 'Champagne & Sparkling', price: 49.95, desc: 'Goldstar winner at the Irish Wine Show. Crisp apple flavors with a full toasty finish.', allergens: 'Sulphites' },
        // Wine - Rosé
        { name: 'Maribeau Rosé (bottle)', course: 'drinks', cat: 'Rosé Wine', price: 30.95, desc: 'Pale pink with aromas of ripe red berries and delicate spice. Refreshing with pleasing acidity. France.', allergens: 'Sulphites' },
        // Wine - White
        { name: 'Sauvignon Blanc (glass)', course: 'drinks', cat: 'White Wine', price: 7.50, desc: 'Crisp Sauvignon Blanc with refreshing citrus aromas, white peaches and lychee. Tocornal, Chile.', allergens: 'Sulphites' },
        { name: 'Sauvignon Blanc (bottle)', course: 'drinks', cat: 'White Wine', price: 24.95, desc: 'Crisp Sauvignon Blanc with refreshing citrus aromas, white peaches and lychee. Tocornal, Chile.', allergens: 'Sulphites' },
        { name: 'Pinot Grigio (glass)', course: 'drinks', cat: 'White Wine', price: 8.50, desc: 'Fresh and elegant with fruity notes of peach and apricot. Villa del lago, Italy.', allergens: 'Sulphites' },
        { name: 'Pinot Grigio (bottle)', course: 'drinks', cat: 'White Wine', price: 31.95, desc: 'Fresh and elegant with fruity notes of peach and apricot. Villa del lago, Italy.', allergens: 'Sulphites' },
        { name: 'Chardonnay Rawsons (bottle)', course: 'drinks', cat: 'White Wine', price: 28.95, desc: 'Creamy with fresh melon, ripe stone fruit. A hint of custard apple and subtle oak. Australia.', allergens: 'Sulphites' },
        { name: 'Gruner Veltliner (bottle)', course: 'drinks', cat: 'White Wine', price: 35.95, desc: 'Bright and crisp, green apple and white pepper notes. Perfectly complements Indian spices. Austria.', allergens: 'Sulphites' },
        { name: 'Rioja Blanco (bottle)', course: 'drinks', cat: 'White Wine', price: 32.95, desc: 'Luis Canas Rioja Blanco — 90% Viura and 10% Malvasia. Barrel fermented 3.5 months in French oak. Spain.', allergens: 'Sulphites' },
        { name: 'Albarino (bottle)', course: 'drinks', cat: 'White Wine', price: 36.95, desc: 'Intense full nose with marked varietal character. Fresh with aromatic complexity. Pionero mundi, Spain.', allergens: 'Sulphites' },
        { name: 'Sauvignon Blanc Organic (bottle)', course: 'drinks', cat: 'White Wine', price: 39.95, desc: 'Lush aroma of passionfruit, gooseberry, blackcurrant. Mineral and refreshing. Marlborough, New Zealand.', allergens: 'Sulphites' },
        { name: 'Chablis Moreau (bottle)', course: 'drinks', cat: 'White Wine', price: 54.95, desc: 'Clean, mineral and perfumed nose, flinty flavours of grapefruit. Fresh, crisp and elegant. France.', allergens: 'Sulphites' },
        // Wine - Red
        { name: 'Cabernet Sauvignon (glass)', course: 'drinks', cat: 'Red Wine', price: 7.50, desc: 'Rich concentrated blackcurrant flavors. Well balanced with a long finish. Tocornal, Chile.', allergens: 'Sulphites' },
        { name: 'Cabernet Sauvignon (bottle)', course: 'drinks', cat: 'Red Wine', price: 24.95, desc: 'Rich concentrated blackcurrant flavors. Well balanced with a long finish. Tocornal, Chile.', allergens: 'Sulphites' },
        { name: 'Shiraz Rawsons (bottle)', course: 'drinks', cat: 'Red Wine', price: 29.95, desc: 'Blackcurrant and cassis with hints of woody spices. Dark fruits, medium body. Australia.', allergens: 'Sulphites' },
        { name: 'Merlot Coastal Reserve (bottle)', course: 'drinks', cat: 'Red Wine', price: 32.95, desc: 'Red and black fruit, vanilla oak. Rich plum, blackberry, hint of liquorice. Spain.', allergens: 'Sulphites' },
        { name: 'Pinot Noir Moreau (bottle)', course: 'drinks', cat: 'Red Wine', price: 32.95, desc: 'Classic French Pinot Noir with delicious ripe red summer fruits. Elegant soft finish. France.', allergens: 'Sulphites' },
        { name: 'Montepulciano Organic (bottle)', course: 'drinks', cat: 'Red Wine', price: 35.95, desc: 'Typical and elegant with clean complex fruit scents. Tore De Beati Organic, Italy.', allergens: 'Sulphites' },
        { name: 'Malbec Andean (bottle)', course: 'drinks', cat: 'Red Wine', price: 36.95, desc: 'Vibrant berry fruit with a hint of violet. Wonderfully fresh and moreish. Argentina.', allergens: 'Sulphites' },
        { name: 'Tempranillo Crianza (bottle)', course: 'drinks', cat: 'Red Wine', price: 38.95, desc: 'Smooth and fruity with gentle tannins. Great persistence and structure. Lopez de Harold, Spain.', allergens: 'Sulphites' },
        { name: 'Ripasso Masi (bottle)', course: 'drinks', cat: 'Red Wine', price: 49.95, desc: 'Strong and attractive cherry flavors. Rich, full bodied, well balanced. Masi Campoforin, Italy.', allergens: 'Sulphites' },
        { name: 'Brolo Masi (bottle)', course: 'drinks', cat: 'Red Wine', price: 55.95, desc: 'Rich, full bodied and packed with baked fruit and hints of cocoa and vanilla. Masi, Italy.', allergens: 'Sulphites' },
        { name: 'Valpolicella Ripasso (bottle)', course: 'drinks', cat: 'Red Wine', price: 58.95, desc: 'Velvety fruit with a big mouth feel. Zenato Valpolicella Ripasso Classico. Highly recommended!', allergens: 'Sulphites' },
        { name: 'Amarone della Valpolicella (bottle)', course: 'drinks', cat: 'Red Wine', price: 99.95, desc: 'Unique bouquet of dried roses, lime zest, cherry sauce. A serious impression. Zenato, Italy.', allergens: 'Sulphites' },
        // Non-alcoholic
        { name: 'Mango Lassi', course: 'drinks', cat: 'Non-Alcoholic', price: 5.95, desc: 'Refreshing blend of mango and yogurt. Contains milk and pistachio nuts.', allergens: 'Milk,Pistachio' },
        { name: 'Coke / Diet Coke / Zero', course: 'drinks', cat: 'Non-Alcoholic', price: 3.00, desc: 'Please specify your preference.', allergens: 'None' },
        { name: '7UP', course: 'drinks', cat: 'Non-Alcoholic', price: 3.00, desc: 'Classic lemon-lime soda.', allergens: 'None' },
        { name: 'Fanta Orange', course: 'drinks', cat: 'Non-Alcoholic', price: 3.00, desc: 'Classic orange soda.', allergens: 'None' },
        { name: 'Still Water', course: 'drinks', cat: 'Non-Alcoholic', price: 3.00, desc: 'Bottled still water.', allergens: 'None' },
        { name: 'Sparkling Water', course: 'drinks', cat: 'Non-Alcoholic', price: 3.00, desc: 'Bottled sparkling water.', allergens: 'None' },
        { name: 'Berry Breeze', course: 'drinks', cat: 'Non-Alcoholic', price: 6.95, desc: 'Refreshing blend of strawberry, lime, mint, and sparkling soda.', allergens: 'None' },
        { name: 'Homemade Lemonade', course: 'drinks', cat: 'Non-Alcoholic', price: 6.95, desc: 'Fresh lemon juice, sparkling soda, and mint for a refreshing twist.', allergens: 'None' },
        // Tea & Coffee
        { name: 'Masala Chai / Tea', course: 'drinks', cat: 'Tea & Coffee', price: 4.95, desc: 'Traditional spiced Indian tea with milk.', allergens: 'Milk' },
        { name: 'Green Tea', course: 'drinks', cat: 'Tea & Coffee', price: 3.50, desc: 'Refreshing green tea.', allergens: 'None' },
        { name: 'Camomile Tea', course: 'drinks', cat: 'Tea & Coffee', price: 3.50, desc: 'Soothing camomile tea.', allergens: 'None' },
        { name: 'Peppermint Tea', course: 'drinks', cat: 'Tea & Coffee', price: 3.50, desc: 'Refreshing peppermint tea.', allergens: 'None' },
        { name: 'English Tea', course: 'drinks', cat: 'Tea & Coffee', price: 3.50, desc: 'Classic English breakfast tea.', allergens: 'None' },
        { name: 'Americano', course: 'drinks', cat: 'Tea & Coffee', price: 4.50, desc: 'Espresso with hot water.', allergens: 'None' },
        { name: 'Espresso', course: 'drinks', cat: 'Tea & Coffee', price: 3.50, desc: 'Strong Italian espresso shot.', allergens: 'None' },
        { name: 'Cappuccino', course: 'drinks', cat: 'Tea & Coffee', price: 4.50, desc: 'Espresso with steamed milk and foam.', allergens: 'Milk' },
        { name: 'Irish Coffee', course: 'drinks', cat: 'Tea & Coffee', price: 7.00, desc: 'Hot coffee with Irish whiskey and cream.', allergens: 'Milk' },
    ];

    const insert = db.prepare('INSERT OR REPLACE INTO menu_items (name, course, category, price, description, allergens, display_order) VALUES (?,?,?,?,?,?,?)');
    menu.forEach((item, idx) => insert.run(item.name, item.course, item.cat, item.price, item.desc, item.allergens, idx));
    console.log(`✓ Full Raha menu created (${menu.length} items)`);
}

// ============= API ROUTES =============


// Serve service worker at root scope (important for offline mode)
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Offline queue sync endpoint - get pending offline orders count
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));


// LOGIN
app.post('/api/login', (req, res) => {
    try {
        if (!checkRateLimit(req.ip)) return res.status(429).json({ success: false, message: 'Too many attempts. Wait 15 minutes.' });
        const { pin } = req.body;
        if (!pin || pin.length !== 4) return res.status(400).json({ success: false, message: 'Invalid PIN' });
        const users = db.prepare('SELECT * FROM users WHERE active = 1').all();
        let user = null;
        for (const u of users) { if (verifyPin(pin, u.pin_hash, u.pin_salt)) { user = u; break; } }
        if (!user) return res.status(401).json({ success: false, message: 'Invalid PIN' });
        const sessionId = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionId, { userId: user.id, name: user.name, role: user.role, loginTime: Date.now() });
        db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
        res.json({ success: true, sessionId, user: { id: user.id, name: user.name, role: user.role } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// MENU
app.get('/api/menu', (req, res) => {
    try {
        const menu = db.prepare('SELECT * FROM menu_items WHERE available = 1 AND deleted = 0 ORDER BY course, display_order').all();
        res.json(menu);
    } catch (err) { res.status(500).json({ error: 'Failed to load menu' }); }
});

app.put('/api/menu/:id', (req, res) => {
    try {
        const { name, price, vat_rate, course, category, description, allergens, available } = req.body;
        db.prepare('UPDATE menu_items SET name=?, price=?, vat_rate=?, course=?, category=?, description=?, allergens=?, available=? WHERE id=?')
            .run(name, price, vat_rate ?? null, course, category, description, allergens, available ? 1 : 0, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update menu item' }); }
});

app.post('/api/menu', (req, res) => {
    try {
        const { name, price, vat_rate, course, category, description, allergens } = req.body;
        const result = db.prepare('INSERT INTO menu_items (name, price, vat_rate, course, category, description, allergens) VALUES (?,?,?,?,?,?,?)')
            .run(name, price, vat_rate ?? null, course || 'mains', category || 'Mains', description || '', allergens || 'None');
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (err) { res.status(500).json({ error: 'Failed to add menu item' }); }
});

// TABLES
app.get('/api/tables', (req, res) => {
    try {
        const tables = db.prepare('SELECT * FROM tables ORDER BY number').all();
        // Attach active order to each table
        const result = tables.map(t => {
            if (t.current_order_id) {
                const order = db.prepare('SELECT id, order_number, status, total, covers FROM orders WHERE id = ?').get(t.current_order_id);
                return { ...t, active_order: order };
            }
            return { ...t, active_order: null };
        });
        res.json(result);
    } catch (err) { res.status(500).json({ error: 'Failed to load tables' }); }
});

app.put('/api/tables/:id', (req, res) => {
    try {
        const { status, current_order_id, opened_at, covers, capacity, name } = req.body;
        db.prepare('UPDATE tables SET status=COALESCE(?,status), current_order_id=COALESCE(?,current_order_id), opened_at=COALESCE(?,opened_at), capacity=COALESCE(?,capacity), name=COALESCE(?,name) WHERE id=?')
            .run(status||null, current_order_id||null, opened_at||null, capacity||null, name||null, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update table' }); }
});

// Clear table
app.post('/api/tables/:id/clear', (req, res) => {
    try {
        db.prepare("UPDATE tables SET status='available', current_order_id=NULL, opened_at=NULL WHERE id=?").run(req.params.id);
        io.emit('table_updated', db.prepare('SELECT * FROM tables WHERE id=?').get(req.params.id));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ORDERS
app.get('/api/orders', (req, res) => {
    try {
        const { status, date, limit, role, mode, table_number } = req.query;
        let query = 'SELECT * FROM orders WHERE deleted = 0';
        const params = [];
        if (status) { query += ' AND status = ?'; params.push(status); }
        if (date)   { query += ' AND DATE(timestamp) = ?'; params.push(date); }
        if (mode)   { query += ' AND mode = ?'; params.push(mode); }
        if (table_number) { query += ' AND table_number = ?'; params.push(parseInt(table_number)); }
        query += ' ORDER BY timestamp DESC';
        if (limit)  { query += ' LIMIT ?'; params.push(parseInt(limit)); }
        const orders = db.prepare(query).all(...params);
        const response = orders.map(o => {
            const order = { ...o, items: JSON.parse(o.items) };
            if (role !== 'admin') { delete order.vat_amount; delete order.net_amount; }
            return order;
        });
        res.json(response);
    } catch (err) { res.status(500).json({ error: 'Failed to load orders' }); }
});

app.post('/api/orders', (req, res) => {
    try {
        const order = req.body;
        if (!order.items || order.items.length === 0) return res.status(400).json({ error: 'Order must have items' });
        const orderNumber = getNextOrderNumber();
        const total = order.total || 0;
        const orderDate = new Date().toISOString();
        const vatRate = getVATRateForDate(orderDate);
        const { vat_amount, net_amount } = calculateVAT(total, vatRate);

        const result = db.prepare(`
            INSERT INTO orders (order_number, timestamp, customer_name, customer_phone, customer_address,
                items, subtotal, delivery_charge, vat_rate, vat_amount, net_amount, total,
                payment_type, mode, table_number, covers, status, created_by, notes, special_instructions, allergies)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)
        `).run(
            orderNumber, orderDate,
            order.customer_name || 'Guest', order.customer_phone || '', order.customer_address || '',
            JSON.stringify(order.items), order.subtotal || 0, order.delivery_charge || 0,
            vatRate, vat_amount, net_amount, total,
            order.payment_type || 'cash', order.mode || 'collection',
            order.table_number || null, order.covers || 1,
            order.created_by || 'staff', order.notes || '', order.special_instructions || '', order.allergies || ''
        );

        const newOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
        newOrder.items = JSON.parse(newOrder.items);

        // Link to table if dine-in
        if (order.table_number) {
            const tableRec = db.prepare('SELECT id FROM tables WHERE number = ?').get(order.table_number);
            if (tableRec) {
                db.prepare("UPDATE tables SET status='occupied', current_order_id=?, opened_at=datetime('now') WHERE id=?")
                    .run(newOrder.id, tableRec.id);
                io.emit('table_updated', db.prepare('SELECT * FROM tables WHERE id=?').get(tableRec.id));
            }
        }

        autoSaveCustomer({ ...order, total });
        const customerOrder = { ...newOrder };
        delete customerOrder.vat_amount; delete customerOrder.net_amount;
        io.emit('new_order', customerOrder);
        res.json({ success: true, order: customerOrder });
    } catch (err) {
        console.error('Create order error:', err);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

app.put('/api/orders/:id/status', (req, res) => {
    try {
        const { id } = req.params;
        const { status, staff_pin } = req.body;
        const timeField = { cooking: 'cooking_started_time', ready: 'ready_time', completed: 'completed_time', cancelled: 'cancelled_time' }[status];
        let query = 'UPDATE orders SET status = ?';
        const params = [status];
        if (timeField) { query += `, ${timeField} = datetime('now')`; }
        query += ' WHERE id = ?';
        params.push(id);
        db.prepare(query).run(...params);

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        if (order) {
            order.items = JSON.parse(order.items);
            // If completed, free the table
            if (status === 'completed' && order.table_number) {
                const tableRec = db.prepare('SELECT id FROM tables WHERE number = ?').get(order.table_number);
                if (tableRec) {
                    db.prepare("UPDATE tables SET status='available', current_order_id=NULL, opened_at=NULL WHERE id=?").run(tableRec.id);
                    io.emit('table_updated', db.prepare('SELECT * FROM tables WHERE id=?').get(tableRec.id));
                }
            }
            io.emit('order_updated', order);
        }
        res.json({ success: true, order });
    } catch (err) { res.status(500).json({ error: 'Failed to update status' }); }
});

// ADMIN: Delete with password
app.delete('/api/admin/:type/:id', (req, res) => {
    try {
        const { type, id } = req.params;
        const { admin_pin, delete_password, permanent } = req.body;
        // Verify both admin PIN and delete password
        const users = db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1").all();
        let isAdmin = false;
        for (const u of users) { if (verifyPin(admin_pin, u.pin_hash, u.pin_salt)) { isAdmin = true; break; } }
        if (!isAdmin) return res.status(403).json({ error: 'Invalid admin PIN' });
        const storedPw = db.prepare("SELECT value FROM settings WHERE key = 'delete_password'").get();
        if (!storedPw || delete_password !== storedPw.value) return res.status(403).json({ error: 'Invalid delete password' });
        const tables = { orders: 'orders', customers: 'customers', menu: 'menu_items' };
        const table = tables[type];
        if (!table) return res.status(400).json({ error: 'Invalid type' });
        if (permanent) {
            db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        } else {
            db.prepare(`UPDATE ${table} SET deleted=1, deleted_by=?, deleted_at=datetime('now') WHERE id=?`).run(admin_pin, id);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to delete' }); }
});

// ADMIN: VAT Report
app.get('/api/admin/vat-report', (req, res) => {
    try {
        const { admin_pin, from_date, to_date } = req.query;
        const users = db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1").all();
        let isAdmin = false;
        for (const u of users) { if (verifyPin(admin_pin, u.pin_hash, u.pin_salt)) { isAdmin = true; break; } }
        if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
        let query = "SELECT * FROM orders WHERE deleted=0 AND status != 'cancelled'";
        const params = [];
        if (from_date) { query += ' AND DATE(timestamp) >= ?'; params.push(from_date); }
        if (to_date)   { query += ' AND DATE(timestamp) <= ?'; params.push(to_date); }
        const orders = db.prepare(query).all(...params);
        res.json({
            period: { from: from_date, to: to_date },
            total_orders: orders.length,
            total_revenue: orders.reduce((s, o) => s + o.total, 0),
            total_vat: orders.reduce((s, o) => s + o.vat_amount, 0),
            total_net: orders.reduce((s, o) => s + o.net_amount, 0)
        });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ADMIN: VAT periods
app.get('/api/admin/vat-periods', (req, res) => {
    try {
        res.json(db.prepare('SELECT * FROM vat_periods ORDER BY start_date DESC').all());
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/vat-periods', (req, res) => {
    try {
        const { start_date, end_date, vat_rate, description } = req.body;
        db.prepare('INSERT INTO vat_periods (start_date, end_date, vat_rate, description) VALUES (?,?,?,?)').run(start_date, end_date||null, vat_rate, description||'');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// DASHBOARD STATS
app.get('/api/dashboard/stats', (req, res) => {
    try {
        const { role } = req.query;
        const today = new Date().toISOString().split('T')[0];
        const safeGet = (stmt, ...params) => {
            try { const row = stmt.get(...params); if (!row) return 0; return row.c !== undefined ? row.c : (row.s !== undefined ? row.s : 0); } catch(e) { return 0; }
        };
        const stats = {
            today_orders:    safeGet(db.prepare("SELECT COUNT(*) as c FROM orders WHERE DATE(timestamp)=? AND deleted=0"), today),
            today_revenue:   safeGet(db.prepare("SELECT COALESCE(SUM(total),0) as s FROM orders WHERE DATE(timestamp)=? AND status!='cancelled' AND deleted=0"), today),
            total_customers: safeGet(db.prepare("SELECT COUNT(*) as c FROM customers WHERE deleted=0")),
            pending_orders:  safeGet(db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='pending' AND deleted=0")),
            cooking_orders:  safeGet(db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='cooking' AND deleted=0")),
            ready_orders:    safeGet(db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='ready' AND deleted=0")),
            dine_in_active:  safeGet(db.prepare("SELECT COUNT(*) as c FROM tables WHERE status='occupied'")),
        };
        if (role === 'admin') {
            stats.today_vat = safeGet(db.prepare("SELECT COALESCE(SUM(vat_amount),0) as s FROM orders WHERE DATE(timestamp)=? AND status!='cancelled' AND deleted=0"), today);
            stats.today_net = safeGet(db.prepare("SELECT COALESCE(SUM(net_amount),0) as s FROM orders WHERE DATE(timestamp)=? AND status!='cancelled' AND deleted=0"), today);
        }
        res.json(stats);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// DAILY SALES
app.get('/api/reports/daily-sales', (req, res) => {
    try {
        const { days = 30 } = req.query;
        const rows = db.prepare(`
            SELECT DATE(timestamp) as date, COUNT(*) as total_orders,
                ROUND(SUM(total),2) as revenue, ROUND(SUM(vat_amount),2) as vat, ROUND(SUM(net_amount),2) as net,
                SUM(CASE WHEN mode='dine-in' THEN 1 ELSE 0 END) as dine_in_count,
                SUM(CASE WHEN mode='delivery' THEN 1 ELSE 0 END) as delivery_count,
                SUM(CASE WHEN mode='collection' THEN 1 ELSE 0 END) as collection_count,
                SUM(CASE WHEN payment_type='cash' THEN 1 ELSE 0 END) as cash_count,
                SUM(CASE WHEN payment_type='card' THEN 1 ELSE 0 END) as card_count
            FROM orders WHERE deleted=0 AND status!='cancelled'
            AND DATE(timestamp) >= DATE('now', '-' || ? || ' days')
            GROUP BY DATE(timestamp) ORDER BY date DESC
        `).all(parseInt(days));
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// CUSTOMERS
app.get('/api/customers', (req, res) => {
    try {
        const { search } = req.query;
        let query = 'SELECT * FROM customers WHERE deleted=0';
        const params = [];
        if (search) { query += ' AND (name LIKE ? OR phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
        query += ' ORDER BY total_orders DESC';
        res.json(db.prepare(query).all(...params));
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/customers', (req, res) => {
    try {
        const { name, phone, email, address, delivery_notes, allergen_info } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        if (phone) {
            const existing = db.prepare("SELECT id FROM customers WHERE phone=? AND deleted=0").get(phone);
            if (existing) {
                db.prepare("UPDATE customers SET name=?,email=?,address=?,delivery_notes=?,allergen_info=?,updated_at=datetime('now') WHERE id=?")
                    .run(name, email||'', address||'', delivery_notes||'', allergen_info||'', existing.id);
                return res.json({ success: true, id: existing.id, updated: true });
            }
        }
        const result = db.prepare("INSERT INTO customers (name,phone,email,address,delivery_notes,allergen_info) VALUES (?,?,?,?,?,?)")
            .run(name, phone||'', email||'', address||'', delivery_notes||'', allergen_info||'');
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/customers/:id/orders', (req, res) => {
    try {
        const cust = db.prepare('SELECT phone FROM customers WHERE id=?').get(req.params.id);
        if (!cust || !cust.phone) return res.json([]);
        const orders = db.prepare("SELECT * FROM orders WHERE customer_phone=? AND deleted=0 ORDER BY timestamp DESC LIMIT 20").all(cust.phone);
        res.json(orders.map(o => ({ ...o, items: JSON.parse(o.items) })));
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// SETTINGS
app.get('/api/settings', (req, res) => {
    try {
        const rows = db.prepare('SELECT key, value FROM settings').all();
        const settings = {};
        rows.forEach(r => { if (r.key !== 'delete_password') settings[r.key] = r.value; });
        res.json(settings);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/settings', (req, res) => {
    try {
        const { key, value } = req.body;
        if (key === 'delete_password') return res.status(403).json({ error: 'Cannot update via this endpoint' });
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// CSV EXPORTS
function toCSV(rows, cols) {
    const lines = rows.map(row => cols.map(col => '"' + String(row[col] ?? '').replace(/"/g, '""') + '"').join(','));
    return [cols.join(','), ...lines].join('\n');
}
app.get('/api/export/orders', (req, res) => {
    try {
        const { from_date, to_date } = req.query;
        let query = "SELECT order_number,timestamp,customer_name,customer_phone,table_number,mode,subtotal,delivery_charge,total,vat_rate,vat_amount,net_amount,payment_type,status,notes FROM orders WHERE deleted=0";
        const params = [];
        if (from_date) { query += ' AND DATE(timestamp)>=?'; params.push(from_date); }
        if (to_date)   { query += ' AND DATE(timestamp)<=?'; params.push(to_date); }
        const rows = db.prepare(query + ' ORDER BY timestamp DESC').all(...params);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="raha-orders.csv"');
        res.send(toCSV(rows, ['order_number','timestamp','customer_name','customer_phone','table_number','mode','subtotal','delivery_charge','total','vat_rate','vat_amount','net_amount','payment_type','status','notes']));
    } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});
app.get('/api/export/customers', (req, res) => {
    try {
        const rows = db.prepare("SELECT name,phone,email,address,delivery_notes,allergen_info,total_orders,total_spent,last_order_date FROM customers WHERE deleted=0 ORDER BY total_orders DESC").all();
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="raha-customers.csv"');
        res.send(toCSV(rows, ['name','phone','email','address','delivery_notes','allergen_info','total_orders','total_spent','last_order_date']));
    } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});
app.get('/api/export/sales', (req, res) => {
    try {
        const { days = 365 } = req.query;
        const rows = db.prepare(`
            SELECT DATE(timestamp) as date, COUNT(*) as total_orders, ROUND(SUM(total),2) as revenue,
                ROUND(SUM(vat_amount),2) as vat, ROUND(SUM(net_amount),2) as net,
                SUM(CASE WHEN mode='dine-in' THEN 1 ELSE 0 END) as dine_in,
                SUM(CASE WHEN mode='delivery' THEN 1 ELSE 0 END) as delivery,
                SUM(CASE WHEN mode='collection' THEN 1 ELSE 0 END) as collection,
                SUM(CASE WHEN payment_type='cash' THEN 1 ELSE 0 END) as cash,
                SUM(CASE WHEN payment_type='card' THEN 1 ELSE 0 END) as card
            FROM orders WHERE deleted=0 AND status!='cancelled'
            AND DATE(timestamp) >= DATE('now', '-' || ? || ' days')
            GROUP BY DATE(timestamp) ORDER BY date DESC
        `).all(parseInt(days));
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="raha-daily-sales.csv"');
        res.send(toCSV(rows, ['date','total_orders','revenue','vat','net','dine_in','delivery','collection','cash','card']));
    } catch (err) { res.status(500).json({ error: 'Export failed' }); }
});

// SOCKET

// ============= STRIPE TERMINAL =============
// Set STRIPE_SECRET_KEY in Railway environment variables
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// Create payment intent for kiosk order
app.post('/api/kiosk/payment-intent', async (req, res) => {
    try {
        if (!stripe) return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY in Railway Variables.' });
        const { amount, currency = 'eur', order_data } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100), // Stripe uses cents
            currency,
            payment_method_types: ['card_present'],
            capture_method: 'automatic',
            metadata: {
                source: 'kiosk',
                table: order_data?.table_number || 'counter',
                mode: order_data?.mode || 'collection',
                items_count: order_data?.items?.length || 0
            }
        });

        res.json({ success: true, client_secret: paymentIntent.client_secret, payment_intent_id: paymentIntent.id });
    } catch (err) {
        console.error('Stripe payment intent error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Create connection token for Stripe Terminal reader
app.post('/api/kiosk/connection-token', async (req, res) => {
    try {
        if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
        const token = await stripe.terminal.connectionTokens.create();
        res.json({ secret: token.secret });
    } catch (err) {
        console.error('Connection token error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Stripe webhook — fires when payment succeeds on Terminal
// Set STRIPE_WEBHOOK_SECRET in Railway Variables
app.post('/api/kiosk/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const sig = req.headers['stripe-signature'];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        let event;

        if (webhookSecret) {
            event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        } else {
            event = JSON.parse(req.body);
        }

        if (event.type === 'payment_intent.succeeded') {
            const pi = event.data.object;
            const orderData = pi.metadata;

            // Auto-create the order in the system
            if (orderData && orderData.source === 'kiosk') {
                console.log('✓ Kiosk payment succeeded:', pi.id);
                // Order was already created optimistically — update status if needed
                const existing = db.prepare("SELECT id FROM orders WHERE notes LIKE ?").get(`%${pi.id}%`);
                if (existing) {
                    db.prepare("UPDATE orders SET payment_type='card', status='pending' WHERE id=?").run(existing.id);
                    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(existing.id);
                    if (order) {
                        order.items = JSON.parse(order.items);
                        io.emit('new_order', order);
                        console.log('✓ Kiosk order confirmed and sent to kitchen:', order.order_number);
                    }
                }
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(400).json({ error: err.message });
    }
});

// Confirm kiosk order after payment (called from kiosk UI)
app.post('/api/kiosk/confirm-order', async (req, res) => {
    try {
        const { payment_intent_id, order } = req.body;

        // Verify payment succeeded with Stripe
        let paymentVerified = false;
        if (stripe && payment_intent_id) {
            const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
            paymentVerified = pi.status === 'succeeded';
        }

        if (!paymentVerified && process.env.STRIPE_SECRET_KEY) {
            return res.status(402).json({ error: 'Payment not confirmed' });
        }

        // Create the order
        const orderNumber = getNextOrderNumber();
        const total = order.total || 0;
        const orderDate = new Date().toISOString();
        const vatRate = getVATRateForDate(orderDate);
        const { vat_amount, net_amount } = calculateVAT(total, vatRate);

        const result = db.prepare(`
            INSERT INTO orders (order_number, timestamp, customer_name, customer_phone,
                items, subtotal, delivery_charge, vat_rate, vat_amount, net_amount, total,
                payment_type, mode, table_number, covers, status, created_by, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)
        `).run(
            orderNumber, orderDate,
            order.customer_name || 'Kiosk Customer',
            order.customer_phone || '',
            JSON.stringify(order.items),
            order.subtotal || 0, order.delivery_charge || 0,
            vatRate, vat_amount, net_amount, total,
            'card', order.mode || 'collection',
            order.table_number || null, order.covers || 1,
            'kiosk',
            `Kiosk order. Payment: ${payment_intent_id || 'verified'}`
        );

        const newOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(result.lastInsertRowid);
        newOrder.items = JSON.parse(newOrder.items);

        // Link table if dine-in
        if (order.table_number) {
            const tableRec = db.prepare('SELECT id FROM tables WHERE number=?').get(order.table_number);
            if (tableRec) {
                db.prepare("UPDATE tables SET status='occupied', current_order_id=?, opened_at=datetime('now') WHERE id=?")
                    .run(newOrder.id, tableRec.id);
                io.emit('table_updated', db.prepare('SELECT * FROM tables WHERE id=?').get(tableRec.id));
            }
        }

        io.emit('new_order', newOrder);
        console.log(`✓ Kiosk order #${orderNumber} confirmed — sent to kitchen`);
        res.json({ success: true, order_number: orderNumber, order: newOrder });

    } catch (err) {
        console.error('Kiosk confirm error:', err);
        res.status(500).json({ error: 'Failed to confirm order' });
    }
});


// ===== STAFF MANAGEMENT =====
app.get('/api/staff', (req, res) => {
    try {
        const staff = db.prepare('SELECT id, name, role, active, last_login, created_at FROM users ORDER BY role, name').all();
        res.json(staff);
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/staff', (req, res) => {
    try {
        const { name, pin, role, admin_pin } = req.body;
        const admins = db.prepare("SELECT * FROM users WHERE role='admin' AND active=1").all();
        let isAdmin = false;
        for (const u of admins) { if (verifyPin(admin_pin, u.pin_hash, u.pin_salt)) { isAdmin = true; break; } }
        if (!isAdmin) return res.status(403).json({ error: 'Admin PIN required' });
        if (!name || !pin || pin.length !== 4 || !role) return res.status(400).json({ error: 'Name, 4-digit PIN and role required' });
        const { hash, salt } = hashPin(pin);
        const result = db.prepare("INSERT INTO users (name, pin_hash, pin_salt, role) VALUES (?,?,?,?)").run(name, hash, salt, role);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch(err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'PIN already in use — choose a different PIN' });
        res.status(500).json({ error: 'Failed to add staff' });
    }
});

app.put('/api/staff/:id', (req, res) => {
    try {
        const { name, role, active, admin_pin } = req.body;
        const admins = db.prepare("SELECT * FROM users WHERE role='admin' AND active=1").all();
        let isAdmin = false;
        for (const u of admins) { if (verifyPin(admin_pin, u.pin_hash, u.pin_salt)) { isAdmin = true; break; } }
        if (!isAdmin) return res.status(403).json({ error: 'Admin PIN required' });
        db.prepare("UPDATE users SET name=?, role=?, active=? WHERE id=?").run(name, role, active ? 1 : 0, req.params.id);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/staff/:id', (req, res) => {
    try {
        const { admin_pin } = req.body;
        const admins = db.prepare("SELECT * FROM users WHERE role='admin' AND active=1").all();
        let isAdmin = false;
        for (const u of admins) { if (verifyPin(admin_pin, u.pin_hash, u.pin_salt)) { isAdmin = true; break; } }
        if (!isAdmin) return res.status(403).json({ error: 'Admin PIN required' });
        // Never delete the last admin
        const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin' AND active=1").get().c;
        const target = db.prepare("SELECT role FROM users WHERE id=?").get(req.params.id);
        if (target && target.role === 'admin' && adminCount <= 1) return res.status(400).json({ error: 'Cannot remove the last admin' });
        db.prepare("UPDATE users SET active=0 WHERE id=?").run(req.params.id);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== CUSTOMER CSV IMPORT =====
app.post('/api/customers/import', (req, res) => {
    try {
        const { customers } = req.body;
        if (!customers || !Array.isArray(customers)) return res.status(400).json({ error: 'Invalid data' });
        const upsert = db.prepare(`INSERT INTO customers (name, phone, email, address, delivery_notes, allergen_info)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(phone) DO UPDATE SET
            name=excluded.name, email=excluded.email, address=excluded.address,
            delivery_notes=excluded.delivery_notes, allergen_info=excluded.allergen_info,
            updated_at=datetime('now')`);
        let imported = 0, skipped = 0;
        const importMany = db.transaction((rows) => {
            for (const c of rows) {
                if (!c.name) { skipped++; continue; }
                try {
                    upsert.run(c.name||'', c.phone||'', c.email||'', c.address||'', c.delivery_notes||'', c.allergen_info||'');
                    imported++;
                } catch(e) { skipped++; }
            }
        });
        importMany(customers);
        res.json({ success: true, imported, skipped });
    } catch(err) { res.status(500).json({ error: 'Import failed: ' + err.message }); }
});

// ===== DATABASE VIEWER (master password) =====
app.get('/api/master/tables', (req, res) => {
    try {
        const { password } = req.query;
        if (!verifyMaster(password)) return res.status(403).json({ error: 'Invalid master password' });
        const tables = {
            orders: db.prepare('SELECT COUNT(*) as count FROM orders WHERE deleted=0').get().count,
            customers: db.prepare('SELECT COUNT(*) as count FROM customers WHERE deleted=0').get().count,
            menu_items: db.prepare('SELECT COUNT(*) as count FROM menu_items WHERE deleted=0').get().count,
            staff: db.prepare('SELECT COUNT(*) as count FROM users WHERE active=1').get().count,
        };
        res.json(tables);
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/master/table/:name', (req, res) => {
    try {
        const { password, limit = 50, offset = 0 } = req.query;
        if (!verifyMaster(password)) return res.status(403).json({ error: 'Invalid master password' });
        const allowed = ['orders', 'customers', 'menu_items', 'users', 'staff_activity'];
        if (!allowed.includes(req.params.name)) return res.status(400).json({ error: 'Invalid table' });
        const rows = db.prepare(`SELECT * FROM ${req.params.name} ORDER BY id DESC LIMIT ? OFFSET ?`).all(parseInt(limit), parseInt(offset));
        const total = db.prepare(`SELECT COUNT(*) as c FROM ${req.params.name}`).get().c;
        res.json({ rows, total });
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/master/table/:name/:id', (req, res) => {
    try {
        const { password } = req.body;
        if (!verifyMaster(password)) return res.status(403).json({ error: 'Invalid master password' });
        const allowed = ['orders', 'customers', 'menu_items'];
        if (!allowed.includes(req.params.name)) return res.status(400).json({ error: 'Invalid table' });
        db.prepare(`DELETE FROM ${req.params.name} WHERE id=?`).run(req.params.id);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== KIOSK UNLOCK PASSWORD =====
app.post('/api/kiosk/verify-unlock', (req, res) => {
    try {
        const { password } = req.body;
        const stored = db.prepare("SELECT value FROM settings WHERE key='kiosk_unlock_password'").get();
        if (!stored) return res.status(404).json({ error: 'No kiosk password set' });
        const match = password === stored.value;
        res.json({ success: match });
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});


io.on('connection', (socket) => {
    console.log('✓ Client connected:', socket.id);
    socket.on('disconnect', () => console.log('✗ Client disconnected:', socket.id));
    socket.emit('connected', { message: 'Connected', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
if (!initDatabase()) { console.error('❌ Database failed'); process.exit(1); }

server.listen(PORT, () => {
    console.log('\n' + '='.repeat(70));
    console.log('🍛 THE RAHA CLOUD POS v4.0');
    console.log('='.repeat(70));
    console.log(`✓ Server: http://localhost:${PORT}`);
    console.log(`✓ Dine-in tables: 10`);
    console.log(`✓ Courses: Starters / Mains / Desserts / Drinks`);
    console.log(`✓ VAT: Dynamic rates (13.5% → 9% from July 2026)`);
    console.log('='.repeat(70) + '\n');
});

process.on('SIGTERM', () => { server.close(() => { db.close(); process.exit(0); }); });
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
        if (now - session.loginTime > SESSION_TIMEOUT) sessions.delete(id);
    }
}, 3600000);

module.exports = app;

// ===== RECEIPT SENDING =====
app.post('/api/receipts/send', async (req, res) => {
    try {
        const { order_id, method, email, phone } = req.body;
        const order = db.prepare('SELECT * FROM orders WHERE id=?').get(order_id);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        order.items = JSON.parse(order.items);
        const receiptHtml = generateReceiptHTML(order);

        if ((method === 'email' || method === 'both') && email) {
            const sgKey = process.env.SENDGRID_API_KEY;
            if (!sgKey) return res.status(503).json({ error: 'Add SENDGRID_API_KEY to Railway Variables to send emails.' });
            const sgMail = require('@sendgrid/mail');
            sgMail.setApiKey(sgKey);
            await sgMail.send({
                to: email,
                from: process.env.FROM_EMAIL || 'hello@rahacuisine.ie',
                subject: 'Your Raha Receipt — Order #' + order.order_number,
                html: receiptHtml
            });
        }

        if ((method === 'sms' || method === 'both') && phone) {
            const twilioSid = process.env.TWILIO_SID;
            if (!twilioSid) return res.status(503).json({ error: 'Add TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM to Railway Variables to send SMS.' });
            const twilio = require('twilio')(twilioSid, process.env.TWILIO_TOKEN);
            const items = order.items.map(i => i.qty + 'x ' + i.name).join(', ');
            const smsText = 'Raha Indian Cuisine\nOrder #' + order.order_number + '\n' + items + '\nTotal: EUR' + order.total.toFixed(2) + '\nVAT: EUR' + (order.vat_amount||0).toFixed(2) + '\nThank you! Atithi Devo Bhava';
            await twilio.messages.create({ body: smsText, from: process.env.TWILIO_FROM, to: phone });
        }

        res.json({ success: true });
    } catch(err) {
        console.error('Receipt error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

function generateReceiptHTML(order) {
    const rows = order.items.map(function(i) {
        return '<tr><td style="padding:8px 0;border-bottom:1px solid #f0e8d8;">' + i.qty + 'x ' + i.name + '</td><td style="padding:8px 0;border-bottom:1px solid #f0e8d8;text-align:right;font-weight:bold;">EUR' + (i.price*i.qty).toFixed(2) + '</td></tr>';
    }).join('');
    var deliveryRow = order.delivery_charge > 0 ? '<tr><td style="padding:6px 0;color:#888;">Delivery</td><td style="text-align:right;">EUR' + order.delivery_charge.toFixed(2) + '</td></tr>' : '';
    var notesBlock = order.notes ? '<div style="margin-top:15px;padding:12px;background:#fffbf0;border-left:3px solid #d4a017;font-size:13px;"><strong>Notes:</strong> ' + order.notes + '</div>' : '';
    return '<!DOCTYPE html><html><body style="font-family:Georgia,serif;max-width:500px;margin:0 auto;background:#fff;color:#1a0a00;">' +
        '<div style="background:#1a0a00;padding:30px;text-align:center;">' +
        '<h1 style="color:#d4a017;margin:0;font-size:28px;letter-spacing:3px;">RAHA</h1>' +
        '<p style="color:#c8511a;margin:8px 0 0;font-size:11px;letter-spacing:4px;">INDIAN CUISINE · DUNDALK</p></div>' +
        '<div style="padding:30px;">' +
        '<p style="color:#888;font-size:11px;margin:0 0 5px;letter-spacing:2px;">ORDER RECEIPT</p>' +
        '<h2 style="color:#c8511a;margin:0 0 5px;font-size:28px;">#' + order.order_number + '</h2>' +
        '<p style="margin:0 0 3px;font-size:13px;color:#555;">' + new Date(order.timestamp).toLocaleString('en-IE') + '</p>' +
        '<p style="margin:0 0 25px;font-size:12px;color:#888;text-transform:capitalize;">' + order.mode + ' · ' + order.payment_type + '</p>' +
        '<table style="width:100%;border-collapse:collapse;">' + rows + '</table>' +
        '<table style="width:100%;border-collapse:collapse;margin-top:15px;padding-top:15px;border-top:2px solid #1a0a00;">' +
        '<tr><td style="padding:6px 0;color:#888;">Subtotal</td><td style="text-align:right;">EUR' + (order.subtotal||0).toFixed(2) + '</td></tr>' +
        deliveryRow +
        '<tr><td style="padding:6px 0;color:#888;">VAT (' + order.vat_rate + '%)</td><td style="text-align:right;">EUR' + (order.vat_amount||0).toFixed(2) + '</td></tr>' +
        '<tr><td style="padding:12px 0 6px;font-size:20px;font-weight:bold;color:#c8511a;">TOTAL</td><td style="text-align:right;font-size:20px;font-weight:bold;color:#c8511a;padding-top:12px;">EUR' + order.total.toFixed(2) + '</td></tr>' +
        '</table>' + notesBlock +
        '<div style="margin-top:25px;text-align:center;padding:20px;background:#fdf8f3;border-radius:8px;">' +
        '<p style="margin:0;color:#888;font-size:12px;">Thank you for choosing Raha</p>' +
        '<p style="margin:6px 0 0;color:#c8511a;font-size:11px;letter-spacing:2px;">ATITHI DEVO BHAVA</p></div></div></body></html>';
}

// ===== CRM UPDATE CUSTOMER =====
app.put('/api/customers/:id', (req, res) => {
    try {
        const { name, phone, email, address, delivery_notes, allergen_info, birthday, vip, loyalty_points, staff_notes, preferences, marketing_opt_in } = req.body;
        db.prepare('UPDATE customers SET name=?,phone=?,email=?,address=?,delivery_notes=?,allergen_info=?,birthday=?,vip=?,loyalty_points=?,staff_notes=?,preferences=?,marketing_opt_in=?,updated_at=datetime(\'now\') WHERE id=?')
            .run(name, phone||'', email||'', address||'', delivery_notes||'', allergen_info||'', birthday||null, vip?1:0, loyalty_points||0, staff_notes||'', preferences||'', marketing_opt_in?1:0, req.params.id);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: 'Failed: ' + err.message }); }
});

app.post('/api/customers/:id/loyalty', (req, res) => {
    try {
        const { points, action } = req.body;
        if (action === 'add') db.prepare('UPDATE customers SET loyalty_points=loyalty_points+? WHERE id=?').run(points||0, req.params.id);
        else db.prepare('UPDATE customers SET loyalty_points=MAX(0,loyalty_points-?) WHERE id=?').run(points||0, req.params.id);
        const c = db.prepare('SELECT loyalty_points FROM customers WHERE id=?').get(req.params.id);
        res.json({ success: true, loyalty_points: c.loyalty_points });
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== MARKETING =====
app.post('/api/marketing/send', async (req, res) => {
    try {
        const { message, subject, method, filter } = req.body;
        let query = 'SELECT * FROM customers WHERE deleted=0 AND marketing_opt_in=1';
        if (filter === 'vip') query += ' AND vip=1';
        if (filter === 'recent') query += " AND last_order_date >= date('now','-30 days')";
        if (filter === 'lapsed') query += " AND last_order_date <= date('now','-60 days')";
        const customers = db.prepare(query).all();
        let sent = 0, failed = 0;

        if (method === 'email') {
            const sgKey = process.env.SENDGRID_API_KEY;
            if (!sgKey) return res.status(503).json({ error: 'Add SENDGRID_API_KEY to Railway Variables.' });
            const sgMail = require('@sendgrid/mail');
            sgMail.setApiKey(sgKey);
            for (const c of customers.filter(function(c){ return c.email; })) {
                try {
                    await sgMail.send({ to: c.email, from: process.env.FROM_EMAIL || 'hello@rahacuisine.ie', subject: subject || 'A message from Raha', html: '<div style="font-family:Georgia,serif;max-width:500px;margin:0 auto;"><div style="background:#1a0a00;padding:20px;text-align:center;"><h1 style="color:#d4a017;margin:0;">RAHA</h1></div><div style="padding:25px;">' + message + '</div><p style="padding:0 25px;font-size:11px;color:#888;">Reply STOP to unsubscribe.</p></div>' });
                    sent++;
                } catch(e) { failed++; }
            }
        } else if (method === 'sms') {
            const twilioSid = process.env.TWILIO_SID;
            if (!twilioSid) return res.status(503).json({ error: 'Add TWILIO_SID to Railway Variables.' });
            const twilio = require('twilio')(twilioSid, process.env.TWILIO_TOKEN);
            for (const c of customers.filter(function(c){ return c.phone; })) {
                try {
                    await twilio.messages.create({ body: 'Raha Indian Cuisine: ' + message + '\nReply STOP to opt out', from: process.env.TWILIO_FROM, to: c.phone });
                    sent++;
                } catch(e) { failed++; }
            }
        }
        res.json({ success: true, sent, failed, total: customers.length });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/marketing/stats', (req, res) => {
    try {
        const stats = {
            total: db.prepare('SELECT COUNT(*) as c FROM customers WHERE deleted=0').get().c,
            opted_in: db.prepare('SELECT COUNT(*) as c FROM customers WHERE deleted=0 AND marketing_opt_in=1').get().c,
            vip: db.prepare('SELECT COUNT(*) as c FROM customers WHERE deleted=0 AND vip=1').get().c,
            recent: db.prepare("SELECT COUNT(*) as c FROM customers WHERE deleted=0 AND last_order_date >= date('now','-30 days')").get().c,
            lapsed: db.prepare("SELECT COUNT(*) as c FROM customers WHERE deleted=0 AND last_order_date <= date('now','-60 days')").get().c,
            with_email: db.prepare("SELECT COUNT(*) as c FROM customers WHERE deleted=0 AND email != '' AND email IS NOT NULL").get().c,
            with_phone: db.prepare("SELECT COUNT(*) as c FROM customers WHERE deleted=0 AND phone != '' AND phone IS NOT NULL").get().c,
        };
        res.json(stats);
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});
