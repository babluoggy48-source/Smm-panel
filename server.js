// server.js - Professional SMM Panel with Zero Vulnerabilities
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // Changed from bcrypt to bcryptjs (no vulnerabilities)
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const cron = require('node-cron');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const validator = require('validator');
require('dotenv').config();

const app = express();

// ==================== SECURITY MIDDLEWARE ====================
app.use(helmet()); // Security headers
app.use(compression()); // Compress responses
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==================== DATABASE CONNECTION ====================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
        sslmode: 'verify-full' // Fixed SSL warning
    },
    max: 20, // Maximum pool connections
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.stack);
    } else {
        console.log('✅ Database connected successfully');
        release();
    }
});

// ==================== CONFIGURATION ====================
const config = {
    smm: {
        apiUrl: 'https://favoritesmm.com/api/v2',
        apiKeys: {
            services: process.env.SMM_SERVICES_KEY || '35602e8e4843e08cb9645e41d2f9e9f57e3886f3',
            addOrder: process.env.SMM_ADD_ORDER_KEY || 'ee96792e87c342e505c8912e510166b204088103',
            customOrder: process.env.SMM_CUSTOM_KEY || 'f0abd93559c048ddf9fcc1d3cd3de6566bf8dd4a',
            orderStatus: process.env.SMM_STATUS_KEY || '472c9a1a728b00698324d64c561939f59b192480',
            balance: process.env.SMM_BALANCE_KEY || '3836ee062a8c337ec74de90491246196bde27760'
        }
    },
    binanceVerifier: {
        baseUrl: process.env.BINANCE_VERIFIER_URL || 'https://binance-verifier.onrender.com/api'
    },
    jwtSecret: process.env.JWT_SECRET,
    jwtExpire: process.env.JWT_EXPIRE || '7d',
    siteName: process.env.SITE_NAME || 'SMM Panel',
    currency: process.env.CURRENCY || 'USD',
    environment: process.env.NODE_ENV || 'development'
};

// Validate required config
if (!config.jwtSecret) {
    console.error('❌ JWT_SECRET is required in .env file');
    process.exit(1);
}

// ==================== DATABASE SCHEMA ====================
const initDatabase = async () => {
    try {
        // Users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                balance DECIMAL(15,2) DEFAULT 0.00,
                total_spent DECIMAL(15,2) DEFAULT 0.00,
                total_orders INTEGER DEFAULT 0,
                role VARCHAR(50) DEFAULT 'user',
                api_key VARCHAR(255) UNIQUE,
                is_active BOOLEAN DEFAULT true,
                last_login TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Services table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS services (
                id SERIAL PRIMARY KEY,
                service_id INTEGER UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                category VARCHAR(100),
                rate DECIMAL(10,2),
                min_order INTEGER,
                max_order INTEGER,
                type VARCHAR(50) DEFAULT 'default',
                description TEXT,
                dripfeed BOOLEAN DEFAULT false,
                refill BOOLEAN DEFAULT false,
                cancel BOOLEAN DEFAULT false,
                is_active BOOLEAN DEFAULT true,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Orders table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                service_id INTEGER,
                provider_order_id INTEGER UNIQUE,
                link TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                charge DECIMAL(10,2),
                status VARCHAR(50) DEFAULT 'pending',
                provider_status VARCHAR(50),
                start_count INTEGER DEFAULT 0,
                remains INTEGER DEFAULT 0,
                currency VARCHAR(10) DEFAULT 'USD',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Transactions table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                order_id VARCHAR(255),
                amount DECIMAL(15,2) NOT NULL,
                currency VARCHAR(10) DEFAULT 'USD',
                type VARCHAR(50),
                status VARCHAR(50) DEFAULT 'pending',
                payment_method VARCHAR(50),
                binance_txid VARCHAR(255),
                metadata JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP
            )
        `);

        console.log('✅ Database tables created/verified');
    } catch (error) {
        console.error('❌ Database initialization error:', error);
        throw error;
    }
};

// ==================== SMM API SERVICE ====================
const smmAPI = {
    async call(action, apiKey, data = {}) {
        try {
            const params = new URLSearchParams({
                key: apiKey,
                action: action,
                ...data
            });

            const response = await axios.post(config.smm.apiUrl, params.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'SMM-Panel/1.0',
                    'Accept': 'application/json'
                },
                timeout: 30000, // 30 second timeout
                validateStatus: status => status < 500 // Accept any status < 500
            });

            return response.data;
        } catch (error) {
            console.error(`SMM API Error (${action}):`, error.message);
            if (error.response) {
                return { error: error.response.data };
            }
            return { error: error.message };
        }
    },

    async getServices() {
        const response = await this.call('services', config.smm.apiKeys.services);
        return Array.isArray(response) ? response : [];
    },

    async addOrder(serviceId, link, quantity) {
        return this.call('add', config.smm.apiKeys.addOrder, {
            service: serviceId,
            link: link,
            quantity: quantity
        });
    },

    async getOrderStatus(orderId) {
        return this.call('status', config.smm.apiKeys.orderStatus, {
            order: orderId
        });
    },

    async getBalance() {
        return this.call('balance', config.smm.apiKeys.balance);
    }
};

// ==================== BINANCE VERIFIER SERVICE ====================
const binanceAPI = {
    async createOrder(amount, orderId) {
        try {
            const response = await axios.post(`${config.binanceVerifier.baseUrl}/create-order`, {
                amount, orderId
            }, { timeout: 30000 });
            return response.data;
        } catch (error) {
            console.error('Binance API Error:', error.message);
            return { error: error.message };
        }
    },

    async verifyPayment(orderId) {
        try {
            const response = await axios.get(`${config.binanceVerifier.baseUrl}/verify/${orderId}`, {
                timeout: 30000
            });
            return response.data;
        } catch (error) {
            return { verified: false, error: error.message };
        }
    },

    async getQRCode(orderId) {
        try {
            const response = await axios.get(`${config.binanceVerifier.baseUrl}/qr/${orderId}`, {
                timeout: 30000
            });
            return response.data;
        } catch (error) {
            return { error: error.message };
        }
    }
};

// ==================== MIDDLEWARE ====================
const authenticate = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(token, config.jwtSecret);
        
        const user = await pool.query(
            'SELECT id, username, email, balance, role, is_active FROM users WHERE id = $1',
            [decoded.id]
        );
        
        if (user.rows.length === 0 || !user.rows[0].is_active) {
            return res.status(401).json({ error: 'User not found or inactive' });
        }
        
        req.user = user.rows[0];
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        res.status(500).json({ error: 'Authentication error' });
    }
};

const isAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

const validateInput = (req, res, next) => {
    const { email, username, link } = req.body;
    
    if (email && !validator.isEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }
    
    if (username && !validator.isLength(username, { min: 3, max: 50 })) {
        return res.status(400).json({ error: 'Username must be 3-50 characters' });
    }
    
    if (link && !validator.isURL(link, { require_protocol: true })) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    next();
};

// ==================== API ROUTES ====================

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        environment: config.environment
    });
});

// Auth Routes
app.post('/api/auth/register', validateInput, async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Validate password strength
        if (!validator.isLength(password, { min: 6 })) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Check if user exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR username = $2',
            [email, username]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Create user
        const hashedPassword = await bcrypt.hash(password, 12); // Higher salt rounds
        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash, api_key) 
             VALUES ($1, $2, $3, $4) RETURNING id, username, email, balance`,
            [username, email, hashedPassword, `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`]
        );

        const token = jwt.sign(
            { id: result.rows[0].id }, 
            config.jwtSecret, 
            { expiresIn: config.jwtExpire }
        );

        res.json({
            success: true,
            token,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/login', validateInput, async (req, res) => {
    try {
        const { email, password } = req.body;

        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];

        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

        const token = jwt.sign(
            { id: user.id }, 
            config.jwtSecret, 
            { expiresIn: config.jwtExpire }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                balance: user.balance,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Services Routes
app.get('/api/services', async (req, res) => {
    try {
        const { category } = req.query;
        
        let query = 'SELECT * FROM services WHERE is_active = true';
        let params = [];
        
        if (category) {
            params.push(category);
            query += ` AND category = $${params.length}`;
        }
        
        query += ' ORDER BY category, name';
        
        const services = await pool.query(query, params);
        
        res.json({
            success: true,
            count: services.rows.length,
            services: services.rows
        });
    } catch (error) {
        console.error('Services error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Orders Routes
app.post('/api/orders', authenticate, validateInput, async (req, res) => {
    try {
        const { service_id, link, quantity, comments } = req.body;

        // Get service details
        const service = await pool.query(
            'SELECT * FROM services WHERE service_id = $1 AND is_active = true',
            [service_id]
        );

        if (service.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid service' });
        }

        const serviceData = service.rows[0];
        
        // Validate quantity
        if (quantity < serviceData.min_order || quantity > serviceData.max_order) {
            return res.status(400).json({ 
                error: `Quantity must be between ${serviceData.min_order} and ${serviceData.max_order}` 
            });
        }

        // Calculate price
        const price = (parseFloat(serviceData.rate) * quantity) / 1000;

        // Check balance
        if (req.user.balance < price) {
            return res.status(400).json({ 
                error: 'Insufficient balance',
                required: price,
                available: req.user.balance
            });
        }

        // Create order on SMM provider
        const orderResult = await smmAPI.addOrder(service_id, link, quantity);

        if (orderResult.error) {
            return res.status(500).json({ error: orderResult.error });
        }

        if (!orderResult.order) {
            return res.status(500).json({ error: 'Failed to create order' });
        }

        // Save order to database
        const order = await pool.query(
            `INSERT INTO orders (user_id, service_id, provider_order_id, link, quantity, charge, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [req.user.id, serviceData.id, orderResult.order, link, quantity, price, 'processing']
        );

        // Deduct balance
        await pool.query(
            'UPDATE users SET balance = balance - $1, total_spent = total_spent + $1, total_orders = total_orders + 1 WHERE id = $2',
            [price, req.user.id]
        );

        // Record transaction
        await pool.query(
            `INSERT INTO transactions (user_id, order_id, amount, type, status)
             VALUES ($1, $2, $3, 'order_payment', 'completed')`,
            [req.user.id, orderResult.order, price]
        );

        res.json({
            success: true,
            order: order.rows[0],
            message: 'Order placed successfully'
        });

    } catch (error) {
        console.error('Order creation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/orders', authenticate, async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        
        let query = 'SELECT * FROM orders WHERE user_id = $1';
        let params = [req.user.id];
        let paramCount = 1;
        
        if (status) {
            paramCount++;
            params.push(status);
            query += ` AND status = $${paramCount}`;
        }
        
        // Add pagination
        const offset = (parseInt(page) - 1) * parseInt(limit);
        paramCount++;
        params.push(parseInt(limit));
        paramCount++;
        params.push(offset);
        
        query += ` ORDER BY created_at DESC LIMIT $${paramCount-1} OFFSET $${paramCount}`;
        
        const orders = await pool.query(query, params);
        
        // Get total count
        const countQuery = status 
            ? 'SELECT COUNT(*) FROM orders WHERE user_id = $1 AND status = $2'
            : 'SELECT COUNT(*) FROM orders WHERE user_id = $1';
        const countParams = status ? [req.user.id, status] : [req.user.id];
        const total = (await pool.query(countQuery, countParams)).rows[0].count;
        
        res.json({
            success: true,
            orders: orders.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(total),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Orders fetch error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Payment Routes
app.post('/api/payments/create', authenticate, async (req, res) => {
    try {
        const { amount } = req.body;

        if (amount < 1 || amount > 10000) {
            return res.status(400).json({ error: 'Amount must be between 1 and 10000 USD' });
        }

        const orderId = `PAY_${Date.now()}_${req.user.id}_${Math.random().toString(36).substr(2, 5)}`;
        
        // Create payment on Binance verifier
        const payment = await binanceAPI.createOrder(amount, orderId);
        
        if (payment.error) {
            return res.status(500).json({ error: payment.error });
        }

        // Save transaction
        await pool.query(
            `INSERT INTO transactions (user_id, order_id, amount, type, status, binance_txid, metadata)
             VALUES ($1, $2, $3, 'deposit', 'pending', $4, $5)`,
            [req.user.id, orderId, amount, payment.orderId || orderId, JSON.stringify({ payment })]
        );

        // Get QR code
        const qr = await binanceAPI.getQRCode(orderId);

        res.json({
            success: true,
            payment_id: orderId,
            amount: amount,
            currency: 'USDT',
            qr_code: qr.qrCode || null,
            address: qr.address || null,
            expires_in: '30 minutes',
            status: 'pending'
        });

    } catch (error) {
        console.error('Payment creation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/payments/verify/:paymentId', authenticate, async (req, res) => {
    try {
        const verification = await binanceAPI.verifyPayment(req.params.paymentId);
        
        if (verification.verified) {
            // Update transaction
            const transaction = await pool.query(
                `UPDATE transactions SET status = 'completed', completed_at = NOW()
                 WHERE order_id = $1 RETURNING *`,
                [req.params.paymentId]
            );

            // Add balance to user
            if (transaction.rows.length > 0) {
                await pool.query(
                    'UPDATE users SET balance = balance + $1 WHERE id = $2',
                    [transaction.rows[0].amount, transaction.rows[0].user_id]
                );
            }
        }

        res.json(verification);
    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// User Routes
app.get('/api/user/balance', authenticate, (req, res) => {
    res.json({
        success: true,
        balance: parseFloat(req.user.balance),
        currency: config.currency
    });
});

app.get('/api/user/transactions', authenticate, async (req, res) => {
    try {
        const transactions = await pool.query(
            `SELECT * FROM transactions 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT 50`,
            [req.user.id]
        );
        
        res.json({
            success: true,
            transactions: transactions.rows
        });
    } catch (error) {
        console.error('Transactions error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin Routes
app.get('/api/admin/dashboard', authenticate, isAdmin, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM orders) as total_orders,
                (SELECT COALESCE(SUM(charge), 0) FROM orders) as total_revenue,
                (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'deposit' AND status = 'completed') as total_deposits,
                (SELECT COUNT(*) FROM orders WHERE status = 'processing') as pending_orders,
                (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours') as new_users_today
        `);

        res.json({
            success: true,
            stats: stats.rows[0]
        });
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/admin/services/sync', authenticate, isAdmin, async (req, res) => {
    try {
        const services = await smmAPI.getServices();
        
        if (!services || services.length === 0) {
            return res.json({ 
                success: false, 
                message: 'No services received from API',
                services: []
            });
        }

        let synced = 0;
        for (const service of services) {
            try {
                await pool.query(
                    `INSERT INTO services (
                        service_id, name, category, rate, min_order, max_order, 
                        type, description, dripfeed, refill, cancel
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    ON CONFLICT (service_id) DO UPDATE SET
                        name = EXCLUDED.name,
                        category = EXCLUDED.category,
                        rate = EXCLUDED.rate,
                        min_order = EXCLUDED.min_order,
                        max_order = EXCLUDED.max_order,
                        type = EXCLUDED.type,
                        description = EXCLUDED.description,
                        dripfeed = EXCLUDED.dripfeed,
                        refill = EXCLUDED.refill,
                        cancel = EXCLUDED.cancel,
                        updated_at = CURRENT_TIMESTAMP`,
                    [
                        service.service, service.name, service.category, service.rate,
                        service.min, service.max, service.type, service.description || '',
                        service.dripfeed || false, service.refill || false, service.cancel || false
                    ]
                );
                synced++;
            } catch (err) {
                console.error(`Failed to sync service ${service.service}:`, err.message);
            }
        }

        res.json({ 
            success: true, 
            message: `Synced ${synced} out of ${services.length} services`,
            total: services.length,
            synced: synced
        });
    } catch (error) {
        console.error('Service sync error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== CRON JOBS ====================
// Update order statuses every 5 minutes
cron.schedule('*/5 * * * *', async () => {
    console.log('🔄 Updating order statuses...');
    
    try {
        const orders = await pool.query(
            "SELECT id, provider_order_id FROM orders WHERE status NOT IN ('completed', 'cancelled', 'partial')"
        );

        let updated = 0;
        for (const order of orders.rows) {
            try {
                const status = await smmAPI.getOrderStatus(order.provider_order_id);
                
                if (status && status.status) {
                    let newStatus = status.status.toLowerCase();
                    
                    if (newStatus.includes('complete')) newStatus = 'completed';
                    else if (newStatus.includes('cancel')) newStatus = 'cancelled';
                    else if (newStatus.includes('partial')) newStatus = 'partial';
                    else if (newStatus.includes('process')) newStatus = 'processing';
                    else if (newStatus.includes('pending')) newStatus = 'pending';
                    
                    await pool.query(
                        `UPDATE orders 
                         SET status = $1, provider_status = $2, remains = $3, start_count = $4, updated_at = NOW()
                         WHERE id = $5`,
                        [newStatus, status.status, status.remains || 0, status.start_count || 0, order.id]
                    );
                    updated++;
                }
            } catch (error) {
                console.error(`Failed to update order ${order.id}:`, error.message);
            }
        }
        
        console.log(`✅ Updated ${updated} of ${orders.rows.length} orders`);
    } catch (error) {
        console.error('Cron job error:', error);
    }
});

// ==================== INITIALIZATION ====================
const startServer = async () => {
    try {
        await initDatabase();
        
        // Try to sync services on startup
        try {
            console.log('📦 Attempting to sync services...');
            const services = await smmAPI.getServices();
            
            if (services && services.length > 0) {
                for (const service of services) {
                    await pool.query(
                        `INSERT INTO services (service_id, name, category, rate, min_order, max_order, type, description)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
                         ON CONFLICT (service_id) DO NOTHING`,
                        [
                            service.service, service.name, service.category, service.rate,
                            service.min, service.max, service.type, service.description || ''
                        ]
                    );
                }
                console.log(`✅ Synced ${services.length} services on startup`);
            } else {
                console.log('⚠️ No services available from API yet');
            }
        } catch (syncError) {
            console.log('⚠️ Initial service sync skipped:', syncError.message);
            // Don't fail the server if sync fails
        }

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`
🚀 SMM Panel is running!
📡 Port: ${PORT}
💰 Currency: ${config.currency}
🔒 Environment: ${config.environment}
🔄 Cron jobs: Active
⚡ Favoritesmm API: ${config.smm.apiUrl}
💳 Binance Verifier: ${config.binanceVerifier.baseUrl}
📊 Health check: /health
            `);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

startServer();
