// server.js - Complete SMM Panel like Favoritesmm
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const cron = require('node-cron');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ==================== DATABASE CONNECTION ====================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==================== CONFIGURATION ====================
const config = {
    smm: {
        apiUrl: 'https://favoritesmm.com/api/v2',
        apiKeys: {
            services: '35602e8e4843e08cb9645e41d2f9e9f57e3886f3',
            addOrder: 'ee96792e87c342e505c8912e510166b204088103',
            customOrder: 'f0abd93559c048ddf9fcc1d3cd3de6566bf8dd4a',
            orderStatus: '472c9a1a728b00698324d64c561939f59b192480',
            massOrder: '7b4101197c61164f3ce9f3dbe7abb39878e3b555',
            refill: '68c264063259cc0c31a96debc335b575d30f279d',
            refillStatus: '327eff619b24a352adc7b4a7a2fc66adcd3f62da',
            cancel: 'b20e9ef14decced22c182f8ddc3dc9e605f97fba',
            balance: '3836ee062a8c337ec74de90491246196bde27760'
        }
    },
    binanceVerifier: {
        baseUrl: 'https://binance-verifier.onrender.com/api'
    },
    jwtSecret: process.env.JWT_SECRET || 'your-secret-key-change-this',
    siteName: 'My SMM Panel',
    currency: 'USD'
};

// ==================== DATABASE SCHEMA (Auto-create) ====================
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Services table (cache from API)
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
                in_stock BOOLEAN DEFAULT true,
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
                type VARCHAR(50) CHECK (type IN ('deposit', 'withdrawal', 'order_payment', 'refund')),
                status VARCHAR(50) DEFAULT 'pending',
                payment_method VARCHAR(50),
                binance_txid VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP
            )
        `);

        // API Keys table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS api_keys (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100),
                key_type VARCHAR(50),
                api_key TEXT NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Categories table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                icon VARCHAR(50),
                sort_order INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT true
            )
        `);

        console.log('✅ Database tables created/verified');
    } catch (error) {
        console.error('❌ Database initialization error:', error);
    }
};

// ==================== SMM API SERVICE (Favoritesmm) ====================
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
                    'User-Agent': 'Mozilla/5.0 (SMM Panel)'
                }
            });

            return response.data;
        } catch (error) {
            console.error(`SMM API Error (${action}):`, error.response?.data || error.message);
            throw error;
        }
    },

    // Get all services/packages
    async getServices() {
        return this.call('services', config.smm.apiKeys.services);
    },

    // Add order (default)
    async addOrder(serviceId, link, quantity) {
        return this.call('add', config.smm.apiKeys.addOrder, {
            service: serviceId,
            link: link,
            quantity: quantity
        });
    },

    // Add order with comments
    async addCustomOrder(serviceId, link, quantity, comments) {
        return this.call('add', config.smm.apiKeys.customOrder, {
            service: serviceId,
            link: link,
            quantity: quantity,
            comments: comments
        });
    },

    // Get order status
    async getOrderStatus(orderId) {
        return this.call('status', config.smm.apiKeys.orderStatus, {
            order: orderId
        });
    },

    // Get multiple orders status
    async getMassOrderStatus(orderIds) {
        return this.call('status', config.smm.apiKeys.massOrder, {
            orders: orderIds.join(',')
        });
    },

    // Request refill
    async requestRefill(orderId) {
        return this.call('refill', config.smm.apiKeys.refill, {
            order: orderId
        });
    },

    // Check refill status
    async getRefillStatus(refillId) {
        return this.call('refill_status', config.smm.apiKeys.refillStatus, {
            refill: refillId
        });
    },

    // Cancel order
    async cancelOrder(orderId) {
        return this.call('cancel', config.smm.apiKeys.cancel, {
            order: orderId
        });
    },

    // Get balance
    async getBalance() {
        return this.call('balance', config.smm.apiKeys.balance);
    }
};

// ==================== BINANCE VERIFIER SERVICE ====================
const binanceAPI = {
    async createOrder(amount, orderId) {
        const response = await axios.post(`${config.binanceVerifier.baseUrl}/create-order`, {
            amount, orderId
        });
        return response.data;
    },

    async verifyPayment(orderId) {
        const response = await axios.get(`${config.binanceVerifier.baseUrl}/verify/${orderId}`);
        return response.data;
    },

    async getQRCode(orderId) {
        const response = await axios.get(`${config.binanceVerifier.baseUrl}/qr/${orderId}`);
        return response.data;
    },

    async getAddress(orderId) {
        const response = await axios.get(`${config.binanceVerifier.baseUrl}/address/${orderId}`);
        return response.data;
    },

    async checkExpired(orderId) {
        const response = await axios.get(`${config.binanceVerifier.baseUrl}/expired/${orderId}`);
        return response.data;
    },

    async getInvoice(orderId) {
        const response = await axios.get(`${config.binanceVerifier.baseUrl}/invoice/${orderId}`);
        return response.data;
    },

    async getBalance() {
        const response = await axios.get(`${config.binanceVerifier.baseUrl}/balance`);
        return response.data;
    },

    async getRecentPayments() {
        const response = await axios.get(`${config.binanceVerifier.baseUrl}/payments`);
        return response.data;
    }
};

// ==================== MIDDLEWARE ====================
const authenticate = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    try {
        const decoded = jwt.verify(token, config.jwtSecret);
        const user = await pool.query(
            'SELECT id, username, email, balance, role FROM users WHERE id = $1',
            [decoded.id]
        );
        
        if (user.rows.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }
        
        req.user = user.rows[0];
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const isAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// ==================== AUTH ROUTES ====================
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body;

    try {
        // Check if user exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR username = $2',
            [email, username]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Create user
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash, api_key) 
             VALUES ($1, $2, $3, $4) RETURNING id, username, email, balance`,
            [username, email, hashedPassword, `user_${Date.now()}`]
        );

        const token = jwt.sign({ id: result.rows[0].id }, config.jwtSecret, { expiresIn: '7d' });

        res.json({
            success: true,
            token,
            user: result.rows[0]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];

        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: user.id }, config.jwtSecret, { expiresIn: '7d' });

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
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/auth/me', authenticate, (req, res) => {
    res.json(req.user);
});

// ==================== SERVICES ROUTES ====================
app.get('/api/services', async (req, res) => {
    try {
        const { category, page = 1, limit = 50 } = req.query;
        
        let query = 'SELECT * FROM services WHERE 1=1';
        let params = [];
        
        if (category) {
            params.push(category);
            query += ` AND category = $${params.length}`;
        }
        
        query += ' ORDER BY category, name LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(limit, (page - 1) * limit);
        
        const services = await pool.query(query, params);
        
        const total = (await pool.query('SELECT COUNT(*) FROM services')).rows[0].count;
        
        res.json({
            services: services.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(total),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/services/:id', async (req, res) => {
    try {
        const service = await pool.query(
            'SELECT * FROM services WHERE service_id = $1 OR id = $2',
            [req.params.id, req.params.id]
        );
        
        if (service.rows.length === 0) {
            return res.status(404).json({ error: 'Service not found' });
        }
        
        res.json(service.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/categories', async (req, res) => {
    try {
        const categories = await pool.query(`
            SELECT DISTINCT category, COUNT(*) as service_count 
            FROM services 
            GROUP BY category 
            ORDER BY category
        `);
        
        res.json(categories.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ORDERS ROUTES ====================
app.post('/api/orders', authenticate, async (req, res) => {
    const { service_id, link, quantity, comments } = req.body;

    try {
        // Get service details
        const service = await pool.query(
            'SELECT * FROM services WHERE service_id = $1',
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
        let orderResult;
        if (comments && serviceData.type === 'custom_comments') {
            orderResult = await smmAPI.addCustomOrder(service_id, link, quantity, comments);
        } else {
            orderResult = await smmAPI.addOrder(service_id, link, quantity);
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
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/orders', authenticate, async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        
        let query = 'SELECT * FROM orders WHERE user_id = $1';
        let params = [req.user.id];
        
        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }
        
        query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(limit, (page - 1) * limit);
        
        const orders = await pool.query(query, params);
        
        const total = (await pool.query(
            'SELECT COUNT(*) FROM orders WHERE user_id = $1',
            [req.user.id]
        )).rows[0].count;
        
        res.json({
            orders: orders.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(total),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/orders/:id', authenticate, async (req, res) => {
    try {
        const order = await pool.query(
            'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        if (order.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Get latest status from provider
        try {
            const providerStatus = await smmAPI.getOrderStatus(order.rows[0].provider_order_id);
            order.rows[0].provider_details = providerStatus;
        } catch (error) {
            console.error('Failed to fetch provider status:', error.message);
        }

        res.json(order.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/orders/:id/refill', authenticate, async (req, res) => {
    try {
        const order = await pool.query(
            'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        if (order.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const refillResult = await smmAPI.requestRefill(order.rows[0].provider_order_id);
        
        res.json({
            success: true,
            refill: refillResult
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/orders/:id/cancel', authenticate, async (req, res) => {
    try {
        const order = await pool.query(
            'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        if (order.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const cancelResult = await smmAPI.cancelOrder(order.rows[0].provider_order_id);
        
        if (!cancelResult.error) {
            await pool.query(
                'UPDATE orders SET status = $1 WHERE id = $2',
                ['cancelled', req.params.id]
            );
        }
        
        res.json({
            success: true,
            result: cancelResult
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== PAYMENT ROUTES ====================
app.post('/api/payments/create', authenticate, async (req, res) => {
    const { amount } = req.body;

    if (amount < 1) {
        return res.status(400).json({ error: 'Minimum amount is 1 USD' });
    }

    try {
        const orderId = `PAY_${Date.now()}_${req.user.id}`;
        
        // Create payment on Binance verifier
        const payment = await binanceAPI.createOrder(amount, orderId);
        
        // Save transaction
        await pool.query(
            `INSERT INTO transactions (user_id, order_id, amount, type, status, binance_txid)
             VALUES ($1, $2, $3, 'deposit', 'pending', $4)`,
            [req.user.id, orderId, amount, payment.orderId || orderId]
        );

        // Get QR code and address
        const [qr, address] = await Promise.all([
            binanceAPI.getQRCode(orderId),
            binanceAPI.getAddress(orderId)
        ]);

        res.json({
            success: true,
            payment_id: orderId,
            amount: amount,
            currency: 'USDT',
            qr_code: qr.qrCode,
            address: address.address,
            expires_in: '30 minutes',
            status: 'pending'
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/payments/status/:paymentId', authenticate, async (req, res) => {
    try {
        const [payment, expired] = await Promise.all([
            binanceAPI.verifyPayment(req.params.paymentId),
            binanceAPI.checkExpired(req.params.paymentId)
        ]);

        res.json({
            verified: payment.verified,
            expired: expired.expired,
            amount: payment.amount,
            transaction_id: payment.transactionId
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/payments/invoice/:paymentId', authenticate, async (req, res) => {
    try {
        const invoice = await binanceAPI.getInvoice(req.params.paymentId);
        res.json(invoice);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== USER ROUTES ====================
app.get('/api/user/balance', authenticate, (req, res) => {
    res.json({
        balance: req.user.balance,
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
        
        res.json(transactions.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/user/stats', authenticate, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_orders,
                COALESCE(SUM(charge), 0) as total_spent,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_orders,
                COUNT(CASE WHEN status = 'processing' THEN 1 END) as pending_orders
            FROM orders 
            WHERE user_id = $1
        `, [req.user.id]);

        res.json({
            balance: req.user.balance,
            ...stats.rows[0]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ADMIN ROUTES ====================
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

        res.json(stats.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/users', authenticate, isAdmin, async (req, res) => {
    try {
        const users = await pool.query(`
            SELECT id, username, email, balance, total_spent, total_orders, role, created_at
            FROM users
            ORDER BY created_at DESC
            LIMIT 100
        `);
        
        res.json(users.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/services/sync', authenticate, isAdmin, async (req, res) => {
    try {
        const services = await smmAPI.getServices();
        
        for (const service of services) {
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
                    service.min, service.max, service.type, service.description,
                    service.dripfeed || false, service.refill || false, service.cancel || false
                ]
            );
        }

        res.json({ 
            success: true, 
            message: `Synced ${services.length} services`,
            count: services.length
        });
    } catch (error) {
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

        for (const order of orders.rows) {
            try {
                const status = await smmAPI.getOrderStatus(order.provider_order_id);
                
                if (status.status) {
                    let newStatus = status.status.toLowerCase();
                    
                    // Map status to our status values
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
                }
            } catch (error) {
                console.error(`Failed to update order ${order.id}:`, error.message);
            }
        }
        
        console.log(`✅ Updated ${orders.rows.length} orders`);
    } catch (error) {
        console.error('Cron job error:', error);
    }
});

// Sync services daily at midnight
cron.schedule('0 0 * * *', async () => {
    console.log('🔄 Syncing services...');
    
    try {
        const services = await smmAPI.getServices();
        
        for (const service of services) {
            await pool.query(
                `INSERT INTO services (
                    service_id, name, category, rate, min_order, max_order, 
                    type, description, dripfeed, refill, cancel
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (service_id) DO UPDATE SET
                    name = EXCLUDED.name,
                    rate = EXCLUDED.rate,
                    min_order = EXCLUDED.min_order,
                    max_order = EXCLUDED.max_order,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    service.service, service.name, service.category, service.rate,
                    service.min, service.max, service.type, service.description,
                    service.dripfeed || false, service.refill || false, service.cancel || false
                ]
            );
        }
        
        console.log(`✅ Synced ${services.length} services`);
    } catch (error) {
        console.error('Service sync error:', error);
    }
});

// ==================== FRONTEND ROUTES ====================
// Serve static files if you have frontend
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all route for SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================
const startServer = async () => {
    await initDatabase();
    
    // Initial service sync
    try {
        const count = (await pool.query('SELECT COUNT(*) FROM services')).rows[0].count;
        if (count === '0') {
            console.log('📦 Syncing services for first time...');
            const services = await smmAPI.getServices();
            for (const service of services) {
                await pool.query(
                    `INSERT INTO services (service_id, name, category, rate, min_order, max_order, type, description)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
                    [service.service, service.name, service.category, service.rate,
                     service.min, service.max, service.type, service.description]
                );
            }
            console.log(`✅ Synced ${services.length} services`);
        }
    } catch (error) {
        console.error('Initial service sync failed:', error);
    }

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`
🚀 SMM Panel is running!
📡 Port: ${PORT}
💰 Currency: ${config.currency}
🔄 Cron jobs: Active
⚡ Favoritesmm API: Connected
💳 Binance Verifier: Connected
        `);
    });
};

startServer();
