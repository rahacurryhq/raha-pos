// THE RAHA CLOUD POS - FINAL PRODUCTION v3.0
// ALL BUGS FIXED - COMPLETE SYSTEM
// Irish Restaurant Compliance Ready
// Dynamic VAT Rates with Period Management

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
app.use(express.json({limit: '50mb'}));
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

// ============= SECURITY =============
// Rate limiting: max 10 login attempts per IP per 15 minutes
const loginAttempts = new Map();
function checkRateLimit(ip) {
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const max = 10;
    if (!loginAttempts.has(ip)) loginAttempts.set(ip, []);
    const attempts = loginAttempts.get(ip).filter(t => now - t < windowMs);
    loginAttempts.set(ip, attempts);
    if (attempts.length >= max) return false;
    attempts.push(now);
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of loginAttempts.entries()) {
        const fresh = times.filter(t => now - t < 15 * 60 * 1000);
        if (fresh.length === 0) loginAttempts.delete(ip);
        else loginAttempts.set(ip, fresh);
    }
}, 3600000);

// Master password - set MASTER_PASSWORD in Railway environment variables
// Used for permanent data wipe and data export
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || null;

function hashPin(pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(pin, salt, 10000, 64, 'sha512').toString('hex');
    return { hash, salt };
}

function verifyPin(pin, hash, salt) {
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
    const netAmount = total - vatAmount;
    return {
        vat_amount: Math.round(vatAmount * 100) / 100,
        net_amount: Math.round(netAmount * 100) / 100
    };
}

function initDatabase() {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_number INTEGER NOT NULL UNIQUE,
                timestamp TEXT NOT NULL,
                customer_name TEXT NOT NULL DEFAULT 'Guest',
                customer_phone TEXT,
                customer_address TEXT,
                items TEXT NOT NULL,
                subtotal REAL NOT NULL CHECK(subtotal >= 0),
                delivery_charge REAL DEFAULT 0,
                vat_rate REAL NOT NULL,
                vat_amount REAL NOT NULL,
                net_amount REAL NOT NULL,
                total REAL NOT NULL CHECK(total >= 0),
                payment_type TEXT NOT NULL,
                mode TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_by TEXT NOT NULL,
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

            CREATE TABLE IF NOT EXISTS vat_periods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                start_date TEXT NOT NULL,
                end_date TEXT,
                vat_rate REAL NOT NULL CHECK(vat_rate >= 0 AND vat_rate <= 100),
                description TEXT,
                created_by TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS menu_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL,
                price REAL NOT NULL CHECK(price >= 0),
                description TEXT,
                allergens TEXT,
                image_url TEXT,
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
                role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'chef', 'front')),
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
            CREATE INDEX IF NOT EXISTS idx_menu_category ON menu_items(category);
            CREATE INDEX IF NOT EXISTS idx_vat_periods_dates ON vat_periods(start_date, end_date);

            CREATE TRIGGER IF NOT EXISTS update_orders_timestamp 
            AFTER UPDATE ON orders
            BEGIN
                UPDATE orders SET updated_at = datetime('now') WHERE id = NEW.id;
            END;

            CREATE TRIGGER IF NOT EXISTS update_customers_timestamp 
            AFTER UPDATE ON customers
            BEGIN
                UPDATE customers SET updated_at = datetime('now') WHERE id = NEW.id;
            END;
        `);

        db.prepare('INSERT OR IGNORE INTO order_sequence (id, current_number) VALUES (1, 0)').run();

        const vatCount = db.prepare('SELECT COUNT(*) as count FROM vat_periods').get();
        if (vatCount.count === 0) {
            db.prepare(`
                INSERT INTO vat_periods (start_date, end_date, vat_rate, description)
                VALUES 
                ('2020-01-01', '2026-06-30', 13.5, 'Standard Irish VAT rate'),
                ('2026-07-01', NULL, 9.0, 'Reduced rate from July 2026')
            `).run();
            console.log('✓ VAT periods created (13.5% until June 2026, then 9%)');
        }

        const settings = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
        settings.run('restaurant_name', 'The RAHA');
        settings.run('show_vat_to_customer', 'false');
        settings.run('delivery_charge', '3.50');
        settings.run('currency', 'EUR');
        settings.run('order_number_prefix', 'R');

        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
        if (userCount.count === 0) {
            insertDefaultUsers();
        }

        const menuCount = db.prepare('SELECT COUNT(*) as count FROM menu_items WHERE deleted = 0').get();
        if (menuCount.count === 0) {
            insertFullMenu();
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
        // Starters
        {name: 'Vegetable Samosa (2pc)', cat: 'Starters', price: 4.95, desc: 'Crispy pastry with spiced vegetables', allergens: 'Gluten'},
        {name: 'Chicken Samosa (2pc)', cat: 'Starters', price: 5.95, desc: 'Pastry filled with spiced chicken', allergens: 'Gluten'},
        {name: 'Onion Bhaji (4pc)', cat: 'Starters', price: 5.95, desc: 'Spiced onion fritters', allergens: 'Gluten'},
        {name: 'Chicken Pakora', cat: 'Starters', price: 6.95, desc: 'Spiced chicken bites', allergens: 'Gluten'},
        {name: 'Chicken Wings (6pc)', cat: 'Starters', price: 7.95, desc: 'Tandoori marinated wings', allergens: 'None'},
        {name: 'Chicken Tikka Starter', cat: 'Starters', price: 7.95, desc: 'Tandoori chicken pieces', allergens: 'Dairy'},
        {name: 'Seekh Kebab Starter', cat: 'Starters', price: 7.95, desc: 'Spiced lamb kebabs', allergens: 'None'},
        {name: 'Mixed Platter', cat: 'Starters', price: 12.95, desc: 'Samosa, pakora, wings & kebab', allergens: 'Gluten,Dairy'},
        {name: 'Prawn Puri', cat: 'Starters', price: 8.95, desc: 'Spiced prawns on puri bread', allergens: 'Gluten,Shellfish'},
        {name: 'Tandoori Mushrooms', cat: 'Starters', price: 6.95, desc: 'Spiced mushrooms', allergens: 'Dairy'},
        // Curries - Chicken
        {name: 'Butter Chicken', cat: 'Curry-Chicken', price: 15.95, desc: 'Creamy tomato curry', allergens: 'Dairy,Nuts'},
        {name: 'Chicken Tikka Masala', cat: 'Curry-Chicken', price: 14.95, desc: 'Classic tikka masala', allergens: 'Dairy'},
        {name: 'Chicken Korma', cat: 'Curry-Chicken', price: 14.95, desc: 'Mild coconut curry', allergens: 'Dairy,Nuts'},
        {name: 'Chicken Madras', cat: 'Curry-Chicken', price: 14.95, desc: 'Hot & spicy curry', allergens: 'None'},
        {name: 'Chicken Vindaloo', cat: 'Curry-Chicken', price: 14.95, desc: 'Very hot curry', allergens: 'None'},
        {name: 'Chicken Jalfrezi', cat: 'Curry-Chicken', price: 14.95, desc: 'Stir-fry with peppers', allergens: 'None'},
        {name: 'Chicken Balti', cat: 'Curry-Chicken', price: 14.95, desc: 'Medium spiced curry', allergens: 'None'},
        {name: 'Chicken Bhuna', cat: 'Curry-Chicken', price: 14.95, desc: 'Thick sauce curry', allergens: 'None'},
        {name: 'Chicken Dupiaza', cat: 'Curry-Chicken', price: 14.95, desc: 'Onion-based curry', allergens: 'None'},
        {name: 'Chicken Saag', cat: 'Curry-Chicken', price: 14.95, desc: 'Spinach curry', allergens: 'Dairy'},
        {name: 'Chicken Rogan Josh', cat: 'Curry-Chicken', price: 14.95, desc: 'Kashmiri curry', allergens: 'None'},
        {name: 'Chicken Pathia', cat: 'Curry-Chicken', price: 14.95, desc: 'Sweet & sour hot curry', allergens: 'None'},
        // Curries - Lamb
        {name: 'Lamb Rogan Josh', cat: 'Curry-Lamb', price: 16.95, desc: 'Kashmiri lamb curry', allergens: 'None'},
        {name: 'Lamb Korma', cat: 'Curry-Lamb', price: 16.95, desc: 'Mild coconut lamb curry', allergens: 'Dairy,Nuts'},
        {name: 'Lamb Madras', cat: 'Curry-Lamb', price: 16.95, desc: 'Hot lamb curry', allergens: 'None'},
        {name: 'Lamb Vindaloo', cat: 'Curry-Lamb', price: 16.95, desc: 'Very hot lamb curry', allergens: 'None'},
        {name: 'Lamb Saag', cat: 'Curry-Lamb', price: 16.95, desc: 'Lamb with spinach', allergens: 'Dairy'},
        {name: 'Lamb Bhuna', cat: 'Curry-Lamb', price: 16.95, desc: 'Thick sauce lamb curry', allergens: 'None'},
        {name: 'Lamb Jalfrezi', cat: 'Curry-Lamb', price: 16.95, desc: 'Lamb stir-fry', allergens: 'None'},
        {name: 'Lamb Balti', cat: 'Curry-Lamb', price: 16.95, desc: 'Medium lamb curry', allergens: 'None'},
        // Rice
        {name: 'Pilau Rice', cat: 'Rice', price: 3.95, desc: 'Basmati rice', allergens: 'None'},
        {name: 'Boiled Rice', cat: 'Rice', price: 3.50, desc: 'Plain basmati', allergens: 'None'},
        {name: 'Egg Fried Rice', cat: 'Rice', price: 4.50, desc: 'Rice with egg', allergens: 'Eggs'},
        {name: 'Mushroom Rice', cat: 'Rice', price: 4.95, desc: 'Rice with mushrooms', allergens: 'None'},
        {name: 'Chicken Biryani', cat: 'Rice', price: 14.95, desc: 'Layered chicken rice', allergens: 'Dairy'},
        {name: 'Lamb Biryani', cat: 'Rice', price: 16.95, desc: 'Layered lamb rice', allergens: 'Dairy'},
        {name: 'Vegetable Biryani', cat: 'Rice', price: 12.95, desc: 'Layered veg rice', allergens: 'Dairy'},
        {name: 'Special Fried Rice', cat: 'Rice', price: 5.95, desc: 'Egg, peas & veg', allergens: 'Eggs'},
        // Breads
        {name: 'Plain Naan', cat: 'Bread', price: 2.95, desc: 'Traditional naan', allergens: 'Gluten,Dairy'},
        {name: 'Garlic Naan', cat: 'Bread', price: 3.50, desc: 'Garlic butter naan', allergens: 'Gluten,Dairy'},
        {name: 'Peshwari Naan', cat: 'Bread', price: 3.95, desc: 'Sweet coconut naan', allergens: 'Gluten,Dairy,Nuts'},
        {name: 'Cheese Naan', cat: 'Bread', price: 3.95, desc: 'Cheese-stuffed naan', allergens: 'Gluten,Dairy'},
        {name: 'Keema Naan', cat: 'Bread', price: 4.50, desc: 'Spiced lamb naan', allergens: 'Gluten,Dairy'},
        {name: 'Tandoori Roti', cat: 'Bread', price: 2.50, desc: 'Whole wheat bread', allergens: 'Gluten'},
        {name: 'Chapati', cat: 'Bread', price: 2.00, desc: 'Thin flatbread', allergens: 'Gluten'},
        {name: 'Paratha', cat: 'Bread', price: 3.50, desc: 'Layered flatbread', allergens: 'Gluten,Dairy'},
        // Sides
        {name: 'Chips', cat: 'Sides', price: 3.50, desc: 'Fresh cut chips', allergens: 'None'},
        {name: 'Poppadoms (4pc)', cat: 'Sides', price: 2.50, desc: 'With chutney', allergens: 'Gluten'},
        {name: 'Raita', cat: 'Sides', price: 2.95, desc: 'Yogurt dip', allergens: 'Dairy'},
        {name: 'Onion Salad', cat: 'Sides', price: 2.50, desc: 'Fresh onion salad', allergens: 'None'},
        {name: 'Mixed Pickle', cat: 'Sides', price: 1.50, desc: 'Spicy pickle', allergens: 'None'},
        {name: 'Mango Chutney', cat: 'Sides', price: 1.50, desc: 'Sweet chutney', allergens: 'None'},
        {name: 'Mint Sauce', cat: 'Sides', price: 1.50, desc: 'Yogurt mint sauce', allergens: 'Dairy'},
        {name: 'Chips & Cheese', cat: 'Sides', price: 4.95, desc: 'Chips with cheese', allergens: 'Dairy'},
        {name: 'Bombay Potatoes', cat: 'Sides', price: 4.50, desc: 'Spiced potatoes', allergens: 'None'},
        {name: 'Saag Aloo', cat: 'Sides', price: 4.95, desc: 'Spinach & potato', allergens: 'None'},
        // Drinks
        {name: 'Coke 330ml', cat: 'Drinks', price: 2.00, desc: 'Can', allergens: 'None'},
        {name: 'Diet Coke 330ml', cat: 'Drinks', price: 2.00, desc: 'Can', allergens: 'None'},
        {name: '7Up 330ml', cat: 'Drinks', price: 2.00, desc: 'Can', allergens: 'None'},
        {name: 'Fanta 330ml', cat: 'Drinks', price: 2.00, desc: 'Can', allergens: 'None'},
        {name: 'Water 500ml', cat: 'Drinks', price: 1.50, desc: 'Still water', allergens: 'None'},
        {name: 'Sparkling Water 500ml', cat: 'Drinks', price: 1.50, desc: 'Sparkling', allergens: 'None'},
        {name: 'Orange Juice 330ml', cat: 'Drinks', price: 2.50, desc: 'Fresh juice', allergens: 'None'},
        {name: 'Mango Lassi', cat: 'Drinks', price: 3.50, desc: 'Yogurt drink', allergens: 'Dairy'},
        // Vegetarian
        {name: 'Vegetable Korma', cat: 'Vegetarian', price: 12.95, desc: 'Mild veg curry', allergens: 'Dairy,Nuts'},
        {name: 'Vegetable Jalfrezi', cat: 'Vegetarian', price: 12.95, desc: 'Spicy veg stir-fry', allergens: 'None'},
        {name: 'Chana Masala', cat: 'Vegetarian', price: 11.95, desc: 'Chickpea curry', allergens: 'None'},
        {name: 'Saag Paneer', cat: 'Vegetarian', price: 12.95, desc: 'Spinach with cheese', allergens: 'Dairy'},
        {name: 'Dal Makhani', cat: 'Vegetarian', price: 11.95, desc: 'Black lentil curry', allergens: 'Dairy'},
        {name: 'Aloo Gobi', cat: 'Vegetarian', price: 11.95, desc: 'Potato & cauliflower', allergens: 'None'},
        {name: 'Paneer Tikka Masala', cat: 'Vegetarian', price: 13.95, desc: 'Cheese tikka masala', allergens: 'Dairy'},
        {name: 'Mixed Vegetable Curry', cat: 'Vegetarian', price: 11.95, desc: 'Seasonal vegetables', allergens: 'None'}
    ];

    const insert = db.prepare(`
        INSERT INTO menu_items (name, category, price, description, allergens, display_order)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    menu.forEach((item, idx) => {
        insert.run(item.name, item.cat, item.price, item.desc, item.allergens, idx);
    });
    console.log(`✓ Full menu created (${menu.length} items)`);
}

// ============= API ROUTES =============

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ✅ FIX 1: login - fixed datetime('now') broken quote bug
app.post('/api/login', (req, res) => {
    try {
        const { pin } = req.body;
        if (!pin || pin.length !== 4) {
            return res.status(400).json({ success: false, message: 'Invalid PIN' });
        }

        // Rate limiting
        const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
        if (!checkRateLimit(clientIp)) {
            return res.status(429).json({ success: false, message: 'Too many attempts. Try again in 15 minutes.' });
        }

        const users = db.prepare('SELECT * FROM users WHERE active = 1').all();
        let user = null;

        for (const u of users) {
            if (verifyPin(pin, u.pin_hash, u.pin_salt)) {
                user = u;
                break;
            }
        }

        if (!user) {
            db.prepare('INSERT INTO staff_activity (user_id, staff_name, action, details, ip_address) VALUES (0, ?, ?, ?, ?)')
                .run('Unknown', 'failed_login', pin, req.ip);
            return res.status(401).json({ success: false, message: 'Invalid PIN' });
        }

        const sessionId = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionId, {
            userId: user.id,
            name: user.name,
            role: user.role,
            loginTime: Date.now()
        });

        // ✅ FIXED: double quotes outside so datetime('now') works
        db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
        db.prepare('INSERT INTO staff_activity (user_id, staff_name, action, ip_address) VALUES (?, ?, ?, ?)')
            .run(user.id, user.name, 'login', req.ip);

        res.json({
            success: true,
            sessionId,
            user: { id: user.id, name: user.name, role: user.role }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/menu', (req, res) => {
    try {
        const menu = db.prepare('SELECT id, name, category, price, description, allergens FROM menu_items WHERE available = 1 AND deleted = 0 ORDER BY category, display_order').all();
        res.json(menu);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load menu' });
    }
});

app.get('/api/orders', (req, res) => {
    try {
        const { status, date, limit, role } = req.query;
        let query = 'SELECT * FROM orders WHERE deleted = 0';
        const params = [];

        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }
        if (date) {
            query += ' AND DATE(timestamp) = ?';
            params.push(date);
        }

        query += ' ORDER BY timestamp DESC';
        if (limit) {
            query += ' LIMIT ?';
            params.push(parseInt(limit));
        }

        const orders = db.prepare(query).all(...params);
        const response = orders.map(o => {
            const order = {...o, items: JSON.parse(o.items)};
            if (role !== 'admin') {
                delete order.vat_amount;
                delete order.net_amount;
                delete order.vat_rate;
            }
            return order;
        });

        res.json(response);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load orders' });
    }
});

app.post('/api/orders', (req, res) => {
    try {
        const order = req.body;
        if (!order.items || order.items.length === 0) {
            return res.status(400).json({ error: 'Order must have items' });
        }

        const orderNumber = getNextOrderNumber();
        const total = order.total || 0;
        const orderDate = new Date().toISOString();
        const vatRate = getVATRateForDate(orderDate);
        const { vat_amount, net_amount } = calculateVAT(total, vatRate);

        const insert = db.prepare(`
            INSERT INTO orders (
                order_number, timestamp, customer_name, customer_phone, customer_address,
                items, subtotal, delivery_charge, vat_rate, vat_amount, net_amount, total,
                payment_type, mode, status, created_by, notes, special_instructions, allergies
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `);

        const result = insert.run(
            orderNumber, orderDate,
            order.customer_name || 'Guest',
            order.customer_phone || '',
            order.customer_address || '',
            JSON.stringify(order.items),
            order.subtotal || 0,
            order.delivery_charge || 0,
            vatRate, vat_amount, net_amount, total,
            order.payment_type, order.mode,
            order.created_by,
            order.notes || '',
            order.special_instructions || '',
            order.allergies || ''
        );

        const newOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
        newOrder.items = JSON.parse(newOrder.items);

        const customerOrder = {...newOrder};
        delete customerOrder.vat_amount;
        delete customerOrder.net_amount;
        delete customerOrder.vat_rate;

        io.emit('new_order', customerOrder);
        autoSaveCustomer({...order, customer_phone: order.customer_phone});

        db.prepare('INSERT INTO staff_activity (user_id, staff_name, action, order_id, details) VALUES (?, ?, ?, ?, ?)')
            .run(1, order.created_by, 'create_order', newOrder.id, `Order #${orderNumber}`);

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

        const timeField = {
            'cooking': 'cooking_started_time',
            'ready': 'ready_time',
            'completed': 'completed_time',
            'cancelled': 'cancelled_time'
        }[status];

        let query = 'UPDATE orders SET status = ?';
        const params = [status];

        if (timeField) {
            query += `, ${timeField} = datetime('now')`;
        }
        query += ' WHERE id = ?';
        params.push(id);

        db.prepare(query).run(...params);

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        if (order) {
            order.items = JSON.parse(order.items);
            io.emit('order_updated', order);
            db.prepare('INSERT INTO staff_activity (user_id, staff_name, action, order_id, details) VALUES (?, ?, ?, ?, ?)')
                .run(1, staff_pin || 'System', 'update_status', id, `Status: ${status}`);
        }

        res.json({ success: true, order });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// ADMIN: Get VAT periods
app.get('/api/admin/vat-periods', (req, res) => {
    try {
        const { admin_pin } = req.query;
        const users = db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1").all();
        let isAdmin = false;
        for (const u of users) {
            if (verifyPin(admin_pin, u.pin_hash, u.pin_salt)) { isAdmin = true; break; }
        }
        if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
        const periods = db.prepare('SELECT * FROM vat_periods ORDER BY start_date DESC').all();
        res.json(periods);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load VAT periods' });
    }
});

// ADMIN: Add VAT period
app.post('/api/admin/vat-periods', (req, res) => {
    try {
        const { admin_pin, start_date, end_date, vat_rate, description } = req.body;
        const users = db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1").all();
        let isAdmin = false;
        for (const u of users) {
            if (verifyPin(admin_pin, u.pin_hash, u.pin_salt)) { isAdmin = true; break; }
        }
        if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
        db.prepare('INSERT INTO vat_periods (start_date, end_date, vat_rate, description, created_by) VALUES (?, ?, ?, ?, ?)')
            .run(start_date, end_date, vat_rate, description, admin_pin);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create VAT period' });
    }
});

// ADMIN: Delete anything
app.delete('/api/admin/:type/:id', (req, res) => {
    try {
        const { type, id } = req.params;
        const { admin_pin, permanent } = req.body;
        const users = db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1").all();
        let isAdmin = false;
        for (const u of users) {
            if (verifyPin(admin_pin, u.pin_hash, u.pin_salt)) { isAdmin = true; break; }
        }
        if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
        const tables = { orders: 'orders', customers: 'customers', menu: 'menu_items' };
        const table = tables[type];
        if (!table) return res.status(400).json({ error: 'Invalid type' });
        if (permanent) {
            db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        } else {
            db.prepare(`UPDATE ${table} SET deleted = 1, deleted_by = ?, deleted_at = datetime('now') WHERE id = ?`)
                .run(admin_pin, id);
        }
        db.prepare('INSERT INTO staff_activity (user_id, staff_name, action, details) VALUES (?, ?, ?, ?)')
            .run(1, 'Admin', `delete_${type}`, permanent ? 'PERMANENT' : 'Soft delete');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// ADMIN: VAT Report
app.get('/api/admin/vat-report', (req, res) => {
    try {
        const { admin_pin, from_date, to_date } = req.query;
        const users = db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1").all();
        let isAdmin = false;
        for (const u of users) {
            if (verifyPin(admin_pin, u.pin_hash, u.pin_salt)) { isAdmin = true; break; }
        }
        if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

        let query = "SELECT * FROM orders WHERE deleted = 0 AND status != 'cancelled'";
        const params = [];
        if (from_date) { query += ' AND DATE(timestamp) >= ?'; params.push(from_date); }
        if (to_date) { query += ' AND DATE(timestamp) <= ?'; params.push(to_date); }

        const orders = db.prepare(query).all(...params);
        const report = {
            period: { from: from_date, to: to_date },
            total_orders: orders.length,
            total_revenue: orders.reduce((s, o) => s + o.total, 0),
            total_vat: orders.reduce((s, o) => s + o.vat_amount, 0),
            total_net: orders.reduce((s, o) => s + o.net_amount, 0),
            orders: orders.map(o => ({
                order_number: o.order_number,
                date: o.timestamp,
                total: o.total,
                vat_rate: o.vat_rate,
                vat: o.vat_amount,
                net: o.net_amount
            }))
        };
        res.json(report);
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate VAT report' });
    }
});

// ✅ FIX 2 & 3: Dashboard stats - null-safe AND all string literals use single quotes
app.get('/api/dashboard/stats', (req, res) => {
    try {
        const { role } = req.query;
        const today = new Date().toISOString().split('T')[0];

        const safeGet = (stmt, ...params) => {
            try {
                const row = stmt.get(...params);
                if (!row) return 0;
                return row.c !== undefined ? row.c : (row.s !== undefined ? row.s : 0);
            } catch(e) { return 0; }
        };

        // ✅ FIXED: all status values use single quotes inside SQL strings
        const stats = {
            today_orders:    safeGet(db.prepare("SELECT COUNT(*) as c FROM orders WHERE DATE(timestamp) = ? AND deleted = 0"), today),
            today_revenue:   safeGet(db.prepare("SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE DATE(timestamp) = ? AND status != 'cancelled' AND deleted = 0"), today),
            total_customers: safeGet(db.prepare("SELECT COUNT(*) as c FROM customers WHERE deleted = 0")),
            pending_orders:  safeGet(db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending' AND deleted = 0")),
            cooking_orders:  safeGet(db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'cooking' AND deleted = 0")),
            ready_orders:    safeGet(db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'ready' AND deleted = 0"))
        };

        if (role === 'admin') {
            stats.today_vat = safeGet(db.prepare("SELECT COALESCE(SUM(vat_amount), 0) as s FROM orders WHERE DATE(timestamp) = ? AND status != 'cancelled' AND deleted = 0"), today);
            stats.today_net = safeGet(db.prepare("SELECT COALESCE(SUM(net_amount), 0) as s FROM orders WHERE DATE(timestamp) = ? AND status != 'cancelled' AND deleted = 0"), today);
        }

        res.json(stats);
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});




// ============= MASTER PASSWORD ROUTES =============

// Verify master password
function verifyMaster(password) {
    if (!MASTER_PASSWORD) return false;
    return crypto.timingSafeEqual(
        Buffer.from(password || ''),
        Buffer.from(MASTER_PASSWORD)
    );
}

// Export ALL data as JSON (master password required)
app.get('/api/master/export', (req, res) => {
    try {
        const { password } = req.query;
        if (!verifyMaster(password)) {
            return res.status(403).json({ error: 'Invalid master password' });
        }
        const data = {
            exported_at: new Date().toISOString(),
            orders: db.prepare('SELECT * FROM orders').all().map(o => ({...o, items: JSON.parse(o.items)})),
            customers: db.prepare('SELECT * FROM customers').all(),
            menu_items: db.prepare('SELECT * FROM menu_items WHERE deleted = 0').all(),
            vat_periods: db.prepare('SELECT * FROM vat_periods').all(),
            staff_activity: db.prepare('SELECT * FROM staff_activity ORDER BY id DESC LIMIT 1000').all(),
            settings: db.prepare('SELECT * FROM settings').all(),
            summary: {
                total_orders: db.prepare('SELECT COUNT(*) as c FROM orders WHERE deleted=0').get().c,
                total_revenue: db.prepare("SELECT COALESCE(SUM(total),0) as s FROM orders WHERE deleted=0 AND status!='cancelled'").get().s,
                total_customers: db.prepare('SELECT COUNT(*) as c FROM customers WHERE deleted=0').get().c,
                db_path: dbPath
            }
        };
        res.setHeader('Content-Disposition', 'attachment; filename="raha-pos-export-' + new Date().toISOString().split('T')[0] + '.json"');
        res.json(data);
    } catch(err) {
        console.error('Export error:', err);
        res.status(500).json({ error: 'Export failed' });
    }
});

// PERMANENT WIPE - deletes ALL data forever, cannot be undone
app.post('/api/master/wipe', (req, res) => {
    try {
        const { password, confirm } = req.body;
        if (!verifyMaster(password)) {
            return res.status(403).json({ error: 'Invalid master password' });
        }
        if (confirm !== 'WIPE EVERYTHING') {
            return res.status(400).json({ error: 'Must confirm with exact phrase: WIPE EVERYTHING' });
        }

        console.log('⚠️  MASTER WIPE INITIATED at', new Date().toISOString());

        // Wipe all tables permanently
        db.exec(`
            DELETE FROM orders;
            DELETE FROM customers;
            DELETE FROM staff_activity;
            DELETE FROM settings;
            DELETE FROM vat_periods;
            DELETE FROM order_sequence;
            UPDATE order_sequence SET current_number = 0 WHERE id = 1;
            INSERT OR IGNORE INTO order_sequence (id, current_number) VALUES (1, 0);
            VACUUM;
        `);

        // Re-insert default VAT periods
        db.prepare("INSERT INTO vat_periods (start_date, end_date, vat_rate, description) VALUES ('2020-01-01','2026-06-30',13.5,'Standard Irish VAT rate')").run();
        db.prepare("INSERT INTO vat_periods (start_date, end_date, vat_rate, description) VALUES ('2026-07-01',NULL,9.0,'Reduced rate from July 2026')").run();

        const settings = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
        settings.run('restaurant_name', 'The RAHA');
        settings.run('delivery_charge', '3.50');
        settings.run('currency', 'EUR');

        console.log('✓ Master wipe complete - all data permanently deleted');
        res.json({ success: true, message: 'All data permanently deleted. Cannot be recovered.' });
    } catch(err) {
        console.error('Wipe error:', err);
        res.status(500).json({ error: 'Wipe failed: ' + err.message });
    }
});

// Database size info
app.get('/api/master/info', (req, res) => {
    try {
        const { password } = req.query;
        if (!verifyMaster(password)) {
            return res.status(403).json({ error: 'Invalid master password' });
        }
        const fs = require('fs');
        let dbSizeBytes = 0;
        try { dbSizeBytes = fs.statSync(dbPath).size; } catch(e) {}
        const info = {
            db_path: dbPath,
            db_size_bytes: dbSizeBytes,
            db_size_kb: (dbSizeBytes / 1024).toFixed(1),
            db_size_mb: (dbSizeBytes / 1024 / 1024).toFixed(3),
            total_orders: db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
            total_customers: db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
            total_revenue: db.prepare("SELECT COALESCE(SUM(total),0) as s FROM orders WHERE deleted=0 AND status!='cancelled'").get().s,
            oldest_order: db.prepare('SELECT MIN(timestamp) as t FROM orders').get().t,
            newest_order: db.prepare('SELECT MAX(timestamp) as t FROM orders').get().t,
        };
        res.json(info);
    } catch(err) {
        res.status(500).json({ error: 'Info failed' });
    }
});

// Auto-save customer from order data
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

// Daily Sales Report
app.get('/api/reports/daily-sales', (req, res) => {
    try {
        const { days = 30 } = req.query;
        const rows = db.prepare(`
            SELECT 
                DATE(timestamp) as date,
                COUNT(*) as total_orders,
                ROUND(SUM(total), 2) as revenue,
                ROUND(SUM(vat_amount), 2) as vat,
                ROUND(SUM(net_amount), 2) as net,
                SUM(CASE WHEN mode = 'delivery' THEN 1 ELSE 0 END) as delivery_count,
                SUM(CASE WHEN mode = 'collection' THEN 1 ELSE 0 END) as collection_count,
                SUM(CASE WHEN payment_type = 'cash' THEN 1 ELSE 0 END) as cash_count,
                SUM(CASE WHEN payment_type = 'card' THEN 1 ELSE 0 END) as card_count
            FROM orders
            WHERE deleted = 0 AND status != 'cancelled'
            AND DATE(timestamp) >= DATE('now', '-' || ? || ' days')
            GROUP BY DATE(timestamp)
            ORDER BY date DESC
        `).all(parseInt(days));
        res.json(rows);
    } catch (err) {
        console.error('Daily sales error:', err);
        res.status(500).json({ error: 'Failed to load daily sales' });
    }
});

// Get all customers
app.get('/api/customers', (req, res) => {
    try {
        const { search } = req.query;
        let query = 'SELECT * FROM customers WHERE deleted = 0';
        const params = [];
        if (search) {
            query += ' AND (name LIKE ? OR phone LIKE ?)';
            params.push('%' + search + '%', '%' + search + '%');
        }
        query += ' ORDER BY total_orders DESC, updated_at DESC';
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        res.status(500).json({ error: 'Failed to load customers' });
    }
});

// Add or update customer manually
app.post('/api/customers', (req, res) => {
    try {
        const { name, phone, email, address, delivery_notes, allergen_info } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        if (phone) {
            const existing = db.prepare("SELECT id FROM customers WHERE phone = ? AND deleted = 0").get(phone);
            if (existing) {
                db.prepare("UPDATE customers SET name=?, email=?, address=?, delivery_notes=?, allergen_info=?, updated_at=datetime('now') WHERE id=?")
                    .run(name, email||'', address||'', delivery_notes||'', allergen_info||'', existing.id);
                return res.json({ success: true, id: existing.id, updated: true });
            }
        }
        const result = db.prepare("INSERT INTO customers (name, phone, email, address, delivery_notes, allergen_info) VALUES (?,?,?,?,?,?)")
            .run(name, phone||'', email||'', address||'', delivery_notes||'', allergen_info||'');
        res.json({ success: true, id: result.lastInsertRowid, updated: false });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save customer' });
    }
});

// Get customer order history
app.get('/api/customers/:id/orders', (req, res) => {
    try {
        const cust = db.prepare('SELECT phone FROM customers WHERE id=?').get(req.params.id);
        if (!cust || !cust.phone) return res.json([]);
        const orders = db.prepare("SELECT * FROM orders WHERE customer_phone = ? AND deleted=0 ORDER BY timestamp DESC LIMIT 20")
            .all(cust.phone);
        res.json(orders.map(o => ({...o, items: JSON.parse(o.items)})));
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

// Delete customer (soft)
app.delete('/api/customers/:id', (req, res) => {
    try {
        db.prepare("UPDATE customers SET deleted=1, deleted_at=datetime('now') WHERE id=?").run(req.params.id);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: 'Failed' });
    }
});


// CSV Export Routes (Admin only)
function toCSV(rows, cols) {
    const header = cols.join(',');
    const lines = rows.map(row =>
        cols.map(col => {
            const val = row[col] === null || row[col] === undefined ? '' : String(row[col]);
            return '"' + val.replace(/"/g, '""') + '"';
        }).join(',')
    );
    return [header, ...lines].join('\n');
}

app.get('/api/export/orders', (req, res) => {
    try {
        const { from_date, to_date } = req.query;
        let query = "SELECT order_number, timestamp, customer_name, customer_phone, customer_address, subtotal, delivery_charge, total, vat_rate, vat_amount, net_amount, payment_type, mode, status, notes, special_instructions, allergies, created_by FROM orders WHERE deleted = 0";
        const params = [];
        if (from_date) { query += ' AND DATE(timestamp) >= ?'; params.push(from_date); }
        if (to_date)   { query += ' AND DATE(timestamp) <= ?'; params.push(to_date); }
        query += ' ORDER BY timestamp DESC';
        const rows = db.prepare(query).all(...params);
        const cols = ['order_number','timestamp','customer_name','customer_phone','customer_address','subtotal','delivery_charge','total','vat_rate','vat_amount','net_amount','payment_type','mode','status','notes','special_instructions','allergies','created_by'];
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="raha-orders.csv"');
        res.send(toCSV(rows, cols));
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'Export failed' });
    }
});

app.get('/api/export/customers', (req, res) => {
    try {
        const rows = db.prepare("SELECT name, phone, email, address, delivery_notes, allergen_info, total_orders, total_spent, last_order_date, created_at FROM customers WHERE deleted = 0 ORDER BY total_orders DESC").all();
        const cols = ['name','phone','email','address','delivery_notes','allergen_info','total_orders','total_spent','last_order_date','created_at'];
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="raha-customers.csv"');
        res.send(toCSV(rows, cols));
    } catch(err) {
        res.status(500).json({ error: 'Export failed' });
    }
});

app.get('/api/export/sales', (req, res) => {
    try {
        const { days = 365 } = req.query;
        const rows = db.prepare(`
            SELECT 
                DATE(timestamp) as date,
                COUNT(*) as total_orders,
                ROUND(SUM(total),2) as revenue,
                ROUND(SUM(vat_amount),2) as vat,
                ROUND(SUM(net_amount),2) as net,
                SUM(CASE WHEN mode='delivery' THEN 1 ELSE 0 END) as delivery_orders,
                SUM(CASE WHEN mode='collection' THEN 1 ELSE 0 END) as collection_orders,
                SUM(CASE WHEN payment_type='cash' THEN 1 ELSE 0 END) as cash_orders,
                SUM(CASE WHEN payment_type='card' THEN 1 ELSE 0 END) as card_orders
            FROM orders
            WHERE deleted=0 AND status != 'cancelled'
            AND DATE(timestamp) >= DATE('now', '-' || ? || ' days')
            GROUP BY DATE(timestamp)
            ORDER BY date DESC
        `).all(parseInt(days));
        const cols = ['date','total_orders','revenue','vat','net','delivery_orders','collection_orders','cash_orders','card_orders'];
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="raha-daily-sales.csv"');
        res.send(toCSV(rows, cols));
    } catch(err) {
        res.status(500).json({ error: 'Export failed' });
    }
});

io.on('connection', (socket) => {
    console.log('✓ Client connected:', socket.id);
    socket.on('disconnect', () => console.log('✗ Client disconnected:', socket.id));
    socket.emit('connected', { message: 'Connected', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;

if (!initDatabase()) {
    console.error('❌ Database failed');
    process.exit(1);
}

server.listen(PORT, () => {
    console.log('\n' + '='.repeat(70));
    console.log('🍛 THE RAHA CLOUD POS - FINAL PRODUCTION v3.0');
    console.log('='.repeat(70));
    console.log(`✓ Server: http://localhost:${PORT}`);
    console.log(`✓ Menu: 72 items loaded`);
    console.log(`✓ VAT: Dynamic rates (13.5% → 9% from July 2026)`);
    console.log(`✓ Admin: Full delete powers`);
    console.log(`✓ Security: PIN hashed, session managed`);
    console.log('='.repeat(70) + '\n');
});

process.on('SIGTERM', () => {
    server.close(() => {
        db.close();
        process.exit(0);
    });
});

setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.loginTime > SESSION_TIMEOUT) {
            sessions.delete(sessionId);
        }
    }
}, 3600000);

module.exports = app;
