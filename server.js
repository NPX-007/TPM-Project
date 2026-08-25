const express = require('express');
const { Pool } = require('pg');
const dns = require('dns');
const path = require('path');
const multer = require('multer');

// บังคับให้ใช้ IPv4 เพื่อแก้ปัญหาเชื่อมต่อบน Render
dns.setDefaultResultOrder('ipv4first');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() }); // หรือใช้ Disk ตามต้องการ

// ฟังก์ชันสร้างตารางทั้งหมดอัตโนมัติเมื่อเริ่มระบบ
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS machines (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                location TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tpm_plans (
                id SERIAL PRIMARY KEY,
                machine_id INT REFERENCES machines(id) ON DELETE CASCADE,
                task_name TEXT NOT NULL,
                next_due_date DATE NOT NULL,
                interval_months INT NOT NULL,
                status TEXT DEFAULT 'รอดำเนินการ',
                notes TEXT,
                image_url TEXT
            );
            CREATE TABLE IF NOT EXISTS breakdowns (
                id SERIAL PRIMARY KEY,
                machine_id INT REFERENCES machines(id) ON DELETE CASCADE,
                breakdown_date DATE NOT NULL,
                downtime_hours NUMERIC NOT NULL,
                repair_cost NUMERIC NOT NULL,
                symptom TEXT NOT NULL,
                cause TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS spare_parts (
                id SERIAL PRIMARY KEY,
                part_name TEXT NOT NULL,
                stock_qty INT NOT NULL,
                min_qty INT NOT NULL
            );
        `);

        // สร้างบัญชี Admin เริ่มต้นถ้ายังไม่มี
        const checkAdmin = await pool.query("SELECT * FROM users WHERE username = 'admin'");
        if (checkAdmin.rows.length === 0) {
            await pool.query(
                "INSERT INTO users (username, password, role) VALUES ($1, $2, $3)",
                ['admin', '1234', 'admin']
            );
            console.log('✅ สร้างบัญชีผู้ใช้เริ่มต้น (admin / 1234) เรียบร้อยแล้ว');
        }
        console.log('✅ ตรวจสอบและสร้างตารางฐานข้อมูลทั้งหมดสำเร็จ');
    } catch (err) {
        console.error('❌ เกิดข้อผิดพลาดในการสร้างตาราง:', err);
    }
}

initDB();

// API Login[cite: 1]
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
        if (result.rows.length > 0) {
            res.json({ success: true, message: 'เข้าสู่ระบบสำเร็จ', user: { username: result.rows[0].username, role: result.rows[0].role } });
        } else {
            res.status(401).json({ success: false, message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์' });
    }
});

// API Dashboard Summary
app.get('/api/dashboard-summary', async (req, res) => {
    try {
        const downtimeRes = await pool.query('SELECT SUM(downtime_hours) as total FROM breakdowns');
        const costRes = await pool.query('SELECT SUM(repair_cost) as total FROM breakdowns');
        const lowStockRes = await pool.query('SELECT COUNT(*) as count FROM spare_parts WHERE stock_qty <= min_qty');
        const plansRes = await pool.query('SELECT status, COUNT(*) as count FROM tpm_plans GROUP BY status');

        res.json({
            downtime: downtimeRes.rows[0].total || 0,
            repairCost: costRes.rows[0].total || 0,
            lowStockCount: lowStockRes.rows[0].count || 0,
            plans: plansRes.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API Machines
app.get('/api/machines', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM machines ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/machines', async (req, res) => {
    const { name, location } = req.body;
    try {
        await pool.query('INSERT INTO machines (name, location) VALUES ($1, $2)', [name, location]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API Plans
app.get('/api/plans/:machineId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tpm_plans WHERE machine_id = $1 ORDER BY next_due_date ASC', [req.params.machineId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/plans', upload.single('image'), async (req, res) => {
    const { machine_id, task_name, next_due_date, interval_months, notes } = req.body;
    let imageUrl = null;
    if (req.file) {
        imageUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }
    try {
        await pool.query(
            'INSERT INTO tpm_plans (machine_id, task_name, next_due_date, interval_months, notes, image_url) VALUES ($1, $2, $3, $4, $5, $6)',
            [machine_id, task_name, next_due_date, interval_months, notes, imageUrl]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/plans/:id/status', async (req, res) => {
    try {
        await pool.query('UPDATE tpm_plans SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API Breakdowns
app.get('/api/breakdowns', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, m.name as machine_name 
            FROM breakdowns b 
            JOIN machines m ON b.machine_id = m.id 
            ORDER BY b.breakdown_date DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/breakdowns', async (req, res) => {
    const { machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause } = req.body;
    try {
        await pool.query(
            'INSERT INTO breakdowns (machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause) VALUES ($1, $2, $3, $4, $5, $6)',
            [machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/breakdowns/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM breakdowns WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API Spare Parts
app.get('/api/spare-parts', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM spare_parts ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/spare-parts', async (req, res) => {
    const { part_name, stock_qty, min_qty } = req.body;
    try {
        await pool.query('INSERT INTO spare_parts (part_name, stock_qty, min_qty) VALUES ($1, $2, $3)', [part_name, stock_qty, min_qty]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/spare-parts/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM spare_parts WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => {
    console.log(`✅ เซิร์ฟเวอร์ทำงานแล้วที่พอร์ต ${port}`);
});