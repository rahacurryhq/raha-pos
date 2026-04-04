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
        settings.run('delete_password', 'Raha@Delete2026');

        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
        if (userCount.count === 0) insertDefaultUsers();

        const menuCount = db.prepare('SELECT COUNT(*) as count FROM menu_items WHERE deleted = 0').get();
        if (menuCount.count === 0) insertFullMenu();

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
        // STARTERS
        { name: 'Vegetable Samosa (2pc)', course: 'starters', cat: 'Starters', price: 4.95, desc: 'Crispy pastry with spiced vegetables', allergens: 'Gluten' },
        { name: 'Chicken Samosa (2pc)', course: 'starters', cat: 'Starters', price: 5.95, desc: 'Pastry filled with spiced chicken', allergens: 'Gluten' },
        { name: 'Onion Bhaji (4pc)', course: 'starters', cat: 'Starters', price: 5.95, desc: 'Spiced onion fritters', allergens: 'Gluten' },
        { name: 'Chicken Pakora', course: 'starters', cat: 'Starters', price: 6.95, desc: 'Spiced chicken bites', allergens: 'Gluten' },
        { name: 'Chicken Wings (6pc)', course: 'starters', cat: 'Starters', price: 7.95, desc: 'Tandoori marinated wings', allergens: 'None' },
        { name: 'Chicken Tikka Starter', course: 'starters', cat: 'Starters', price: 7.95, desc: 'Tandoori chicken pieces', allergens: 'Dairy' },
        { name: 'Seekh Kebab Starter', course: 'starters', cat: 'Starters', price: 7.95, desc: 'Spiced lamb kebabs', allergens: 'None' },
        { name: 'Mixed Platter', course: 'starters', cat: 'Starters', price: 12.95, desc: 'Samosa, pakora, wings & kebab', allergens: 'Gluten,Dairy' },
        { name: 'Prawn Puri', course: 'starters', cat: 'Starters', price: 8.95, desc: 'Spiced prawns on puri bread', allergens: 'Gluten,Shellfish' },
        { name: 'Tandoori Mushrooms', course: 'starters', cat: 'Starters', price: 6.95, desc: 'Spiced mushrooms', allergens: 'Dairy' },
        // MAINS - Chicken
        { name: 'Butter Chicken', course: 'mains', cat: 'Curry-Chicken', price: 15.95, desc: 'Creamy tomato curry', allergens: 'Dairy,Nuts' },
        { name: 'Chicken Tikka Masala', course: 'mains', cat: 'Curry-Chicken', price: 14.95, desc: 'Classic tikka masala', allergens: 'Dairy' },
        { name: 'Chicken Korma', course: 'mains', cat: 'Curry-Chicken', price: 14.95, desc: 'Mild coconut curry', allergens: 'Dairy,Nuts' },
        { name: 'Chicken Madras', course: 'mains', cat: 'Curry-Chicken', price: 14.95, desc: 'Hot & spicy curry', allergens: 'None' },
        { name: 'Chicken Vindaloo', course: 'mains', cat: 'Curry-Chicken', price: 14.95, desc: 'Very hot curry', allergens: 'None' },
        { name: 'Chicken Jalfrezi', course: 'mains', cat: 'Curry-Chicken', price: 14.95, desc: 'Stir-fry with peppers', allergens: 'None' },
        { name: 'Chicken Balti', course: 'mains', cat: 'Curry-Chicken', price: 14.95, desc: 'Medium spiced curry', allergens: 'None' },
        { name: 'Chicken Bhuna', course: 'mains', cat: 'Curry-Chicken', price: 14.95, desc: 'Thick sauce curry', allergens: 'None' },
        { name: 'Chicken Saag', course: 'mains', cat: 'Curry-Chicken', price: 14.95, desc: 'Spinach curry', allergens: 'Dairy' },
        { name: 'Chicken Rogan Josh', course: 'mains', cat: 'Curry-Chicken', price: 14.95, desc: 'Kashmiri curry', allergens: 'None' },
        // MAINS - Lamb
        { name: 'Lamb Rogan Josh', course: 'mains', cat: 'Curry-Lamb', price: 16.95, desc: 'Kashmiri lamb curry', allergens: 'None' },
        { name: 'Lamb Korma', course: 'mains', cat: 'Curry-Lamb', price: 16.95, desc: 'Mild coconut lamb curry', allergens: 'Dairy,Nuts' },
        { name: 'Lamb Madras', course: 'mains', cat: 'Curry-Lamb', price: 16.95, desc: 'Hot lamb curry', allergens: 'None' },
        { name: 'Lamb Vindaloo', course: 'mains', cat: 'Curry-Lamb', price: 16.95, desc: 'Very hot lamb curry', allergens: 'None' },
        { name: 'Lamb Saag', course: 'mains', cat: 'Curry-Lamb', price: 16.95, desc: 'Lamb with spinach', allergens: 'Dairy' },
        { name: 'Lamb Jalfrezi', course: 'mains', cat: 'Curry-Lamb', price: 16.95, desc: 'Lamb stir-fry', allergens: 'None' },
        // MAINS - Vegetarian
        { name: 'Vegetable Korma', course: 'mains', cat: 'Vegetarian', price: 12.95, desc: 'Mild veg curry', allergens: 'Dairy,Nuts' },
        { name: 'Chana Masala', course: 'mains', cat: 'Vegetarian', price: 11.95, desc: 'Chickpea curry', allergens: 'None' },
        { name: 'Saag Paneer', course: 'mains', cat: 'Vegetarian', price: 12.95, desc: 'Spinach with cheese', allergens: 'Dairy' },
        { name: 'Dal Makhani', course: 'mains', cat: 'Vegetarian', price: 11.95, desc: 'Black lentil curry', allergens: 'Dairy' },
        { name: 'Paneer Tikka Masala', course: 'mains', cat: 'Vegetarian', price: 13.95, desc: 'Cheese tikka masala', allergens: 'Dairy' },
        // MAINS - Rice & Bread sides
        { name: 'Pilau Rice', course: 'mains', cat: 'Rice', price: 3.95, desc: 'Basmati rice', allergens: 'None' },
        { name: 'Boiled Rice', course: 'mains', cat: 'Rice', price: 3.50, desc: 'Plain basmati', allergens: 'None' },
        { name: 'Egg Fried Rice', course: 'mains', cat: 'Rice', price: 4.50, desc: 'Rice with egg', allergens: 'Eggs' },
        { name: 'Chicken Biryani', course: 'mains', cat: 'Rice', price: 14.95, desc: 'Layered chicken rice', allergens: 'Dairy' },
        { name: 'Lamb Biryani', course: 'mains', cat: 'Rice', price: 16.95, desc: 'Layered lamb rice', allergens: 'Dairy' },
        { name: 'Plain Naan', course: 'mains', cat: 'Bread', price: 2.95, desc: 'Traditional naan', allergens: 'Gluten,Dairy' },
        { name: 'Garlic Naan', course: 'mains', cat: 'Bread', price: 3.50, desc: 'Garlic butter naan', allergens: 'Gluten,Dairy' },
        { name: 'Peshwari Naan', course: 'mains', cat: 'Bread', price: 3.95, desc: 'Sweet coconut naan', allergens: 'Gluten,Dairy,Nuts' },
        { name: 'Keema Naan', course: 'mains', cat: 'Bread', price: 4.50, desc: 'Spiced lamb naan', allergens: 'Gluten,Dairy' },
        { name: 'Chips', course: 'mains', cat: 'Sides', price: 3.50, desc: 'Fresh cut chips', allergens: 'None' },
        { name: 'Raita', course: 'mains', cat: 'Sides', price: 2.95, desc: 'Yogurt dip', allergens: 'Dairy' },
        { name: 'Bombay Potatoes', course: 'mains', cat: 'Sides', price: 4.50, desc: 'Spiced potatoes', allergens: 'None' },
        { name: 'Saag Aloo', course: 'mains', cat: 'Sides', price: 4.95, desc: 'Spinach & potato', allergens: 'None' },
        // DESSERTS
        { name: 'Gulab Jamun', course: 'desserts', cat: 'Desserts', price: 4.95, desc: 'Soft milk dumplings in syrup', allergens: 'Dairy,Gluten' },
        { name: 'Kulfi Ice Cream', course: 'desserts', cat: 'Desserts', price: 4.95, desc: 'Traditional Indian ice cream', allergens: 'Dairy,Nuts' },
        { name: 'Mango Sorbet', course: 'desserts', cat: 'Desserts', price: 4.50, desc: 'Refreshing mango sorbet', allergens: 'None' },
        { name: 'Rice Pudding (Kheer)', course: 'desserts', cat: 'Desserts', price: 4.95, desc: 'Creamy rice pudding', allergens: 'Dairy,Nuts' },
        { name: 'Chocolate Brownie', course: 'desserts', cat: 'Desserts', price: 5.50, desc: 'With vanilla ice cream', allergens: 'Dairy,Gluten,Eggs' },
        // DRINKS
        { name: 'Mango Lassi', course: 'drinks', cat: 'Drinks', price: 3.50, desc: 'Yogurt mango drink', allergens: 'Dairy' },
        { name: 'Rose Lassi', course: 'drinks', cat: 'Drinks', price: 3.50, desc: 'Rose flavoured lassi', allergens: 'Dairy' },
        { name: 'Masala Chai', course: 'drinks', cat: 'Drinks', price: 2.95, desc: 'Spiced Indian tea', allergens: 'Dairy' },
        { name: 'Coke 330ml', course: 'drinks', cat: 'Drinks', price: 2.50, desc: 'Can', allergens: 'None' },
        { name: 'Diet Coke 330ml', course: 'drinks', cat: 'Drinks', price: 2.50, desc: 'Can', allergens: 'None' },
        { name: '7Up 330ml', course: 'drinks', cat: 'Drinks', price: 2.50, desc: 'Can', allergens: 'None' },
        { name: 'Still Water 500ml', course: 'drinks', cat: 'Drinks', price: 2.00, desc: 'Bottled water', allergens: 'None' },
        { name: 'Sparkling Water 500ml', course: 'drinks', cat: 'Drinks', price: 2.00, desc: 'Sparkling water', allergens: 'None' },
        { name: 'Orange Juice', course: 'drinks', cat: 'Drinks', price: 2.95, desc: 'Fresh juice', allergens: 'None' },
    ];
    const insert = db.prepare('INSERT INTO menu_items (name, course, category, price, description, allergens, display_order) VALUES (?,?,?,?,?,?,?)');
    menu.forEach((item, idx) => insert.run(item.name, item.course, item.cat, item.price, item.desc, item.allergens, idx));
    console.log(`✓ Menu created (${menu.length} items)`);
}

// ============= API ROUTES =============

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
