const express = require('express');
const { Pool } = require('pg');
const dns = require('dns');
const path = require('path');
const multer = require('multer');

// บังคับ DNS เป็น IPv4 เพื่อป้องกันปัญหาการเชื่อมต่อบน Render
const originalLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    const newOptions = Object.assign({}, typeof options === 'object' ? options : { family: options }, { family: 4 });
    return originalLookup(hostname, newOptions, callback);
};

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// สร้างตารางข้อมูลอัตโนมัติ
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user'
            );
            CREATE TABLE IF NOT EXISTS machines (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                location TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS spare_parts (
                id SERIAL PRIMARY KEY,
                part_name TEXT NOT NULL,
                stock_qty INT NOT NULL,
                min_qty INT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tpm_plans (
                id SERIAL PRIMARY KEY,
                machine_id INT REFERENCES machines(id) ON DELETE CASCADE,
                task_name TEXT NOT NULL,
                next_due_date DATE NOT NULL,
                interval_months INT NOT NULL,
                status TEXT DEFAULT 'รอดำเนินการ',
                notes TEXT,
                image_url TEXT,
                spare_part_id INT REFERENCES spare_parts(id) ON DELETE SET NULL
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
        `);

        // อัปเดตโครงสร้างตารางเดิมให้รองรับการเชื่อมอะไหล่
        await pool.query(`
            ALTER TABLE tpm_plans ADD COLUMN IF NOT EXISTS spare_part_id INT REFERENCES spare_parts(id) ON DELETE SET NULL;
        `);

        // สร้าง Admin เริ่มต้น
        const checkAdmin = await pool.query("SELECT * FROM users WHERE username = 'admin'");
        if (checkAdmin.rows.length === 0) {
            await pool.query("INSERT INTO users (username, password, role) VALUES ($1, $2, $3)", ['admin', '1234', 'admin']);
            console.log('✅ สร้างบัญชีผู้ใช้เริ่มต้น (admin / 1234) เรียบร้อยแล้ว');
        }
    } catch (err) {
        console.error('❌ เกิดข้อผิดพลาดในการสร้างตาราง:', err);
    }
}
initDB();

// --- API จัดการผู้ใช้งาน ---

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const checkUser = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (checkUser.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว' });
        }
        await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, password, 'user']);
        res.json({ success: true, message: 'ลงทะเบียนสำเร็จ! กรุณาเข้าสู่ระบบ' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT id, username, role FROM users WHERE username = $1 AND password = $2', [username, password]);
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, role FROM users ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/users/:id/role', async (req, res) => {
    try {
        await pool.query('UPDATE users SET role = $1 WHERE id = $2', [req.body.role, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// อัปเดตข้อมูลส่วนตัว (เปลี่ยนชื่อได้โดยไม่ต้องเปลี่ยนรหัสผ่าน)
app.patch('/api/users/profile', async (req, res) => {
    const { userId, oldPassword, newUsername, newPassword } = req.body;
    try {
        // ตรวจสอบชื่อซ้ำ
        const nameCheck = await pool.query('SELECT * FROM users WHERE username = $1 AND id != $2', [newUsername, userId]);
        if (nameCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว' });
        }

        // กรณีมีการระบุรหัสผ่านใหม่ ให้ยืนยันรหัสผ่านเดิมด้วย
        if (newPassword && newPassword.trim() !== '') {
            if (!oldPassword) {
                return res.status(400).json({ success: false, message: 'กรุณากรอกรหัสผ่านเดิมเพื่อเปลี่ยนรหัสผ่านใหม่' });
            }
            const userCheck = await pool.query('SELECT * FROM users WHERE id = $1 AND password = $2', [userId, oldPassword]);
            if (userCheck.rows.length === 0) {
                return res.status(400).json({ success: false, message: 'รหัสผ่านเดิมไม่ถูกต้อง' });
            }
            const updateRes = await pool.query(
                'UPDATE users SET username = $1, password = $2 WHERE id = $3 RETURNING id, username, role',
                [newUsername, newPassword, userId]
            );
            return res.json({ success: true, message: 'อัปเดตชื่อและรหัสผ่านเรียบร้อยแล้ว', user: updateRes.rows[0] });
        } else {
            // กรณีเปลี่ยนเฉพาะชื่อผู้ใช้งาน
            const updateRes = await pool.query(
                'UPDATE users SET username = $1 WHERE id = $2 RETURNING id, username, role',
                [newUsername, userId]
            );
            return res.json({ success: true, message: 'อัปเดตชื่อผู้ใช้งานเรียบร้อยแล้ว', user: updateRes.rows[0] });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- API TPM & CMMS ---

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
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/machines', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM machines ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/machines', async (req, res) => {
    try {
        await pool.query('INSERT INTO machines (name, location) VALUES ($1, $2)', [req.body.name, req.body.location]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/machines/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM machines WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/plans/:machineId', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, sp.part_name as spare_part_name 
            FROM tpm_plans p 
            LEFT JOIN spare_parts sp ON p.spare_part_id = sp.id 
            WHERE p.machine_id = $1 
            ORDER BY p.next_due_date ASC
        `, [req.params.machineId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/plans-master', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, m.name as machine_name, m.location, sp.part_name as spare_part_name 
            FROM tpm_plans p 
            JOIN machines m ON p.machine_id = m.id 
            LEFT JOIN spare_parts sp ON p.spare_part_id = sp.id 
            ORDER BY p.next_due_date ASC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/plans-overdue', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, m.name as machine_name, m.location, sp.part_name as spare_part_name 
            FROM tpm_plans p 
            JOIN machines m ON p.machine_id = m.id 
            LEFT JOIN spare_parts sp ON p.spare_part_id = sp.id 
            WHERE p.status != 'เสร็จสิ้น' AND p.next_due_date < CURRENT_DATE 
            ORDER BY p.next_due_date ASC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/plans-history', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, m.name as machine_name, m.location, sp.part_name as spare_part_name 
            FROM tpm_plans p 
            JOIN machines m ON p.machine_id = m.id 
            LEFT JOIN spare_parts sp ON p.spare_part_id = sp.id 
            WHERE p.status = 'เสร็จสิ้น' 
            ORDER BY p.next_due_date DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/plans', upload.single('image'), async (req, res) => {
    const { machine_id, task_name, next_due_date, interval_months, notes, spare_part_id } = req.body;
    let imageUrl = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : null;
    const spId = (spare_part_id && spare_part_id !== '') ? parseInt(spare_part_id) : null;
    try {
        await pool.query(
            'INSERT INTO tpm_plans (machine_id, task_name, next_due_date, interval_months, notes, image_url, spare_part_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [machine_id, task_name, next_due_date, interval_months, notes, imageUrl, spId]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/plans/:id/status', async (req, res) => {
    const { status } = req.body;
    try {
        const oldPlan = await pool.query('SELECT * FROM tpm_plans WHERE id = $1', [req.params.id]);
        await pool.query('UPDATE tpm_plans SET status = $1 WHERE id = $2', [status, req.params.id]);

        // หากปรับสถานะเป็น 'เสร็จสิ้น' ให้ตัดสต็อกอะไหล่ 1 ชิ้นอัตโนมัติ
        if (status === 'เสร็จสิ้น' && oldPlan.rows.length > 0 && oldPlan.rows[0].status !== 'เสร็จสิ้น') {
            const spId = oldPlan.rows[0].spare_part_id;
            if (spId) {
                await pool.query('UPDATE spare_parts SET stock_qty = GREATEST(0, stock_qty - 1) WHERE id = $1', [spId]);
            }
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/plans/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM tpm_plans WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/breakdowns', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, m.name as machine_name 
            FROM breakdowns b 
            JOIN machines m ON b.machine_id = m.id 
            ORDER BY b.breakdown_date DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/breakdowns', async (req, res) => {
    const { machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause } = req.body;
    try {
        await pool.query(
            'INSERT INTO breakdowns (machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause) VALUES ($1, $2, $3, $4, $5, $6)',
            [machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/breakdowns/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM breakdowns WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- API จัดการคลังอะไหล่ ---

app.get('/api/spare-parts', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM spare_parts ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/spare-parts', async (req, res) => {
    const { part_name, stock_qty, min_qty } = req.body;
    try {
        await pool.query('INSERT INTO spare_parts (part_name, stock_qty, min_qty) VALUES ($1, $2, $3)', [part_name, stock_qty, min_qty]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/spare-parts/:id', async (req, res) => {
    const { part_name, stock_qty, min_qty } = req.body;
    try {
        await pool.query(
            'UPDATE spare_parts SET part_name = $1, stock_qty = $2, min_qty = $3 WHERE id = $4',
            [part_name, parseInt(stock_qty), parseInt(min_qty), req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/spare-parts/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM spare_parts WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(port, () => {
    console.log(`✅ เซิร์ฟเวอร์ทำงานแล้วที่พอร์ต ${port}`);
});