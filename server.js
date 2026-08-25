const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');

const app = express();
const port = process.env.PORT || 3000;

// Config การเชื่อมต่อ PostgreSQL
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'tpm_db',
    password: process.env.DB_PASSWORD || 'postgres',
    port: process.env.DB_PORT || 5432,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// Database Setup & Auto Migration
// ----------------------------------------------------
const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(20) DEFAULT 'member', -- admin, member, user
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS machines (
                id SERIAL PRIMARY KEY,
                name VARCHAR(250) NOT NULL,
                code VARCHAR(100)
            );

            CREATE TABLE IF NOT EXISTS spare_parts (
                id SERIAL PRIMARY KEY,
                part_name VARCHAR(250) NOT NULL,
                stock_qty INT DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS plans (
                id SERIAL PRIMARY KEY,
                machine_id INT REFERENCES machines(id) ON DELETE CASCADE,
                task_name VARCHAR(250) NOT NULL,
                interval_months INT DEFAULT 1,
                spare_part_id INT REFERENCES spare_parts(id) ON DELETE SET NULL,
                next_due_date DATE NOT NULL,
                status VARCHAR(50) DEFAULT 'รอดำเนินการ',
                notes TEXT,
                image_url TEXT
            );

            CREATE TABLE IF NOT EXISTS breakdowns (
                id SERIAL PRIMARY KEY,
                machine_id INT REFERENCES machines(id) ON DELETE CASCADE,
                issue_description TEXT NOT NULL,
                reported_by VARCHAR(100),
                status VARCHAR(50) DEFAULT 'แจ้งซ่อม',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS plan_history (
                id SERIAL PRIMARY KEY,
                machine_id INT,
                task_name TEXT,
                interval_months INT,
                spare_part_id INT,
                completed_date DATE DEFAULT CURRENT_DATE,
                notes TEXT,
                image_url TEXT
            );
        `);

        // สร้างผู้ใช้ Admin เริ่มต้น (ถ้ายืดหยุ่น)
        const checkAdmin = await pool.query("SELECT * FROM users WHERE username = 'admin'");
        if (checkAdmin.rows.length === 0) {
            const hashPass = await bcrypt.hash('123456', 10);
            await pool.query("INSERT INTO users (username, password, role) VALUES ('admin', $1, 'admin')", [hashPass]);
            console.log('👤 Admin Account Initialized: admin / 123456');
        }

        console.log('✅ Initialized Database Tables Successfully');
    } catch (err) {
        console.error('❌ Database Initialization Error:', err);
    }
};
initDb();

// ----------------------------------------------------
// 1. Auth & User Management API (ระบบสมาชิก/สิทธิ์การใช้งาน)
// ----------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (rows.length === 0) return res.status(401).json({ success: false, message: 'ไม่พบผู้ใช้งานนี้' });

        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match && password !== user.password) {
            return res.status(401).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
        }

        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/users/profile', async (req, res) => {
    const { id, username, password } = req.body;
    try {
        if (password) {
            const hashed = await bcrypt.hash(password, 10);
            await pool.query('UPDATE users SET username = $1, password = $2 WHERE id = $3', [username, hashed, id]);
        } else {
            await pool.query('UPDATE users SET username = $1 WHERE id = $2', [username, id]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------------------------------
// 2. Dashboard API
// ----------------------------------------------------
app.get('/api/dashboard', async (req, res) => {
    try {
        const machinesCount = await pool.query('SELECT COUNT(*) FROM machines');
        const pendingCount = await pool.query("SELECT COUNT(*) FROM plans WHERE status = 'รอดำเนินการ'");
        const overdueCount = await pool.query("SELECT COUNT(*) FROM plans WHERE next_due_date < CURRENT_DATE AND status != 'เสร็จสิ้น'");
        const lowStockCount = await pool.query('SELECT COUNT(*) FROM spare_parts WHERE stock_qty <= 2');
        const breakdownCount = await pool.query("SELECT COUNT(*) FROM breakdowns WHERE status != 'ซ่อมเสร็จแล้ว'");

        res.json({
            totalMachines: parseInt(machinesCount.rows[0].count),
            pendingPlans: parseInt(pendingCount.rows[0].count),
            overduePlans: parseInt(overdueCount.rows[0].count),
            lowStockParts: parseInt(lowStockCount.rows[0].count),
            activeBreakdowns: parseInt(breakdownCount.rows[0].count)
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------------------------------
// 3. Machines API
// ----------------------------------------------------
app.get('/api/machines', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM machines ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/machines', async (req, res) => {
    try {
        const { name, code } = req.body;
        const { rows } = await pool.query('INSERT INTO machines (name, code) VALUES ($1, $2) RETURNING *', [name, code]);
        res.json({ success: true, data: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/machines/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM machines WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------------------------------
// 4. Spare Parts API
// ----------------------------------------------------
app.get('/api/spare-parts', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM spare_parts ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/spare-parts', async (req, res) => {
    try {
        const { part_name, stock_qty } = req.body;
        const { rows } = await pool.query('INSERT INTO spare_parts (part_name, stock_qty) VALUES ($1, $2) RETURNING *', [part_name, stock_qty || 0]);
        res.json({ success: true, data: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/spare-parts/:id', async (req, res) => {
    try {
        const { part_name, stock_qty } = req.body;
        await pool.query('UPDATE spare_parts SET part_name = $1, stock_qty = $2 WHERE id = $3', [part_name, stock_qty, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------------------------------
// 5. TPM Maintenance Plans API
// ----------------------------------------------------
app.get('/api/plans', async (req, res) => {
    try {
        const { machine_id } = req.query;
        let query = `
            SELECT p.*, m.name as machine_name, s.part_name as spare_part_name 
            FROM plans p
            JOIN machines m ON p.machine_id = m.id
            LEFT JOIN spare_parts s ON p.spare_part_id = s.id
        `;
        const params = [];
        if (machine_id) {
            query += ' WHERE p.machine_id = $1';
            params.push(machine_id);
        }
        query += ' ORDER BY p.next_due_date ASC';

        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/plans/overdue', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT p.*, m.name as machine_name, s.part_name as spare_part_name 
            FROM plans p
            JOIN machines m ON p.machine_id = m.id
            LEFT JOIN spare_parts s ON p.spare_part_id = s.id
            WHERE p.next_due_date < CURRENT_DATE AND p.status != 'เสร็จสิ้น'
            ORDER BY p.next_due_date ASC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/plans', async (req, res) => {
    try {
        const { machine_id, task_name, interval_months, spare_part_id, next_due_date, notes, image_url } = req.body;
        const { rows } = await pool.query(`
            INSERT INTO plans (machine_id, task_name, interval_months, spare_part_id, next_due_date, notes, image_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
        `, [machine_id, task_name, interval_months, spare_part_id || null, next_due_date, notes, image_url]);
        res.json({ success: true, data: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/plans/:id', async (req, res) => {
    try {
        const { machine_id, task_name, interval_months, spare_part_id, next_due_date, notes, image_url } = req.body;
        await pool.query(`
            UPDATE plans 
            SET machine_id = $1, task_name = $2, interval_months = $3, spare_part_id = $4, next_due_date = $5, notes = $6, image_url = $7
            WHERE id = $8
        `, [machine_id, task_name, interval_months, spare_part_id || null, next_due_date, notes, image_url, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/plans/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM plans WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// เปลี่ยนสถานะแผนงาน: บันทึกประวัติ -> ตัดสต็อก -> ตั้งวันรอบถัดไป -> รีเซ็ตเป็น "รอดำเนินการ"
app.patch('/api/plans/:id/status', async (req, res) => {
    const client = await pool.connect();
    try {
        const { status } = req.body;
        const id = parseInt(req.params.id);

        await client.query('BEGIN');

        if (status === 'เสร็จสิ้น') {
            const { rows } = await client.query('SELECT * FROM plans WHERE id = $1', [id]);
            const plan = rows[0];

            if (!plan) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลแผนงาน' });
            }

            // 1. บันทึกประวัติ
            await client.query(`
                INSERT INTO plan_history (machine_id, task_name, interval_months, spare_part_id, completed_date, notes, image_url)
                VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6)
            `, [plan.machine_id, plan.task_name, plan.interval_months, plan.spare_part_id, plan.notes, plan.image_url]);

            // 2. ตัดสต็อก
            if (plan.spare_part_id) {
                await client.query('UPDATE spare_parts SET stock_qty = GREATEST(0, stock_qty - 1) WHERE id = $1', [plan.spare_part_id]);
            }

            // 3. บวกรอบวันถัดไป และรีเซ็ตสถานะกลับเป็น "รอดำเนินการ"
            await client.query(`
                UPDATE plans 
                SET next_due_date = (next_due_date + (interval_months || ' month')::interval)::date,
                    status = 'รอดำเนินการ'
                WHERE id = $1
            `, [id]);

            await client.query('COMMIT');
            return res.json({ success: true, isReset: true, message: 'บันทึกประวัติ ตัดสต็อก และรีเซ็ตตั้งรอบถัดไปสำเร็จ' });
        }

        await client.query('UPDATE plans SET status = $1 WHERE id = $2', [status, id]);
        await client.query('COMMIT');
        res.json({ success: true, isReset: false });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ----------------------------------------------------
// 6. Breakdown / CMMS API (ระบบแจ้งซ่อม)
// ----------------------------------------------------
app.get('/api/breakdowns', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT b.*, m.name as machine_name 
            FROM breakdowns b 
            JOIN machines m ON b.machine_id = m.id 
            ORDER BY b.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/breakdowns', async (req, res) => {
    try {
        const { machine_id, issue_description, reported_by } = req.body;
        const { rows } = await pool.query(`
            INSERT INTO breakdowns (machine_id, issue_description, reported_by) 
            VALUES ($1, $2, $3) RETURNING *
        `, [machine_id, issue_description, reported_by]);
        res.json({ success: true, data: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/breakdowns/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        await pool.query('UPDATE breakdowns SET status = $1 WHERE id = $2', [status, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ----------------------------------------------------
// 7. Plan History API
// ----------------------------------------------------
app.get('/api/plans-history', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT h.*, m.name as machine_name, s.part_name as spare_part_name 
            FROM plan_history h
            LEFT JOIN machines m ON h.machine_id = m.id
            LEFT JOIN spare_parts s ON h.spare_part_id = s.id
            ORDER BY h.completed_date DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(port, () => {
    console.log(`🚀 TPM System running on port ${port}`);
});