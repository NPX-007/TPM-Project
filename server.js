const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ตรวจสอบและสร้างโฟลเดอร์ uploads อัตโนมัติถ้ายังไม่มีในระบบ
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// ตั้งค่า Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static(uploadDir));

// ตั้งค่า File Upload ด้วย Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// เชื่อมต่อฐานข้อมูล PostgreSQL (Supabase)
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ====================================================
// 1. AUTHENTICATION & USER MANAGEMENT API
// ====================================================

// เข้าสู่ระบบ
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const { rows } = await db.query(
            'SELECT id, username, role FROM users WHERE username = $1 AND password = $2',
            [username, password]
        );
        if (rows.length > 0) {
            res.json({ success: true, user: rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// สมัครสมาชิก
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const { rows: existing } = await db.query(
            'SELECT id FROM users WHERE username = $1',
            [username]
        );
        if (existing.length > 0) {
            return res.json({ success: false, message: 'ชื่อผู้ใช้งานนี้มีอยู่ในระบบแล้ว' });
        }
        await db.query(
            'INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
            [username, password, 'user']
        );
        res.json({ success: true, message: 'สมัครสมาชิกเรียบร้อยแล้ว' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ดึงข้อมูลสมาชิกทั้งหมด (ส่ง Password มาด้วยเพื่อแสดงผลฝั่ง Admin)
app.get('/api/users', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT id, username, password, role FROM users ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// เปลี่ยนสิทธิ์การใช้งาน (Role)
app.patch('/api/users/:id/role', async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;
        await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
        res.json({ success: true, message: 'อัปเดตสิทธิ์ผู้ใช้เรียบร้อยแล้ว' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ลบบัญชีสมาชิก
app.delete('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true, message: 'ลบบัญชีผู้ใช้งานเรียบร้อยแล้ว' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// แก้ไขข้อมูลส่วนตัว / เปลี่ยนรหัสผ่าน
app.patch('/api/users/profile', async (req, res) => {
    try {
        const { userId, oldPassword, newUsername, newPassword } = req.body;
        
        if (newPassword) {
            const { rows: check } = await db.query(
                'SELECT id FROM users WHERE id = $1 AND password = $2',
                [userId, oldPassword]
            );
            if (check.length === 0) {
                return res.json({ success: false, message: 'รหัสผ่านเดิมไม่ถูกต้อง' });
            }
            await db.query(
                'UPDATE users SET username = $1, password = $2 WHERE id = $3',
                [newUsername, newPassword, userId]
            );
        } else {
            await db.query(
                'UPDATE users SET username = $1 WHERE id = $2',
                [newUsername, userId]
            );
        }

        const { rows: updated } = await db.query(
            'SELECT id, username, role FROM users WHERE id = $1',
            [userId]
        );
        res.json({ success: true, message: 'แก้ไขข้อมูลส่วนตัวสำเร็จ', user: updated[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ====================================================
// 2. DASHBOARD & MACHINE API
// ====================================================

app.get('/api/dashboard-summary', async (req, res) => {
    try {
        const { rows: bdRows } = await db.query(
            'SELECT COALESCE(SUM(downtime_hours), 0) as downtime, COALESCE(SUM(repair_cost), 0) as "repairCost" FROM breakdowns'
        );
        const { rows: stockRows } = await db.query(
            'SELECT COUNT(*)::int as "lowStockCount" FROM spare_parts WHERE stock_qty <= min_qty'
        );
        const { rows: plans } = await db.query(
            'SELECT status, COUNT(*)::int as count FROM plans GROUP BY status'
        );

        const bdSum = bdRows[0] || { downtime: 0, repairCost: 0 };
        const lowStock = stockRows[0] || { lowStockCount: 0 };

        res.json({
            downtime: Number(bdSum.downtime),
            repairCost: Number(bdSum.repairCost),
            lowStockCount: lowStock.lowStockCount,
            plans
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/machines', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM machines ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/machines', async (req, res) => {
    try {
        const { name, location } = req.body;
        await db.query('INSERT INTO machines (name, location) VALUES ($1, $2)', [name, location]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/machines/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM plans WHERE machine_id = $1', [id]);
        await db.query('DELETE FROM machines WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ====================================================
// 3. TPM PLANS API
// ====================================================

app.get('/api/plans-master', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT p.*, m.name as machine_name, m.location, s.part_name as spare_part_name 
            FROM plans p
            JOIN machines m ON p.machine_id = m.id
            LEFT JOIN spare_parts s ON p.spare_part_id = s.id
            ORDER BY p.next_due_date ASC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/plans-overdue', async (req, res) => {
    try {
        const { rows } = await db.query(`
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

app.get('/api/plans-history', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT p.*, m.name as machine_name, s.part_name as spare_part_name 
            FROM plans p
            JOIN machines m ON p.machine_id = m.id
            LEFT JOIN spare_parts s ON p.spare_part_id = s.id
            WHERE p.status = 'เสร็จสิ้น'
            ORDER BY p.next_due_date DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/plans/:machineId', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT p.*, s.part_name as spare_part_name 
            FROM plans p
            LEFT JOIN spare_parts s ON p.spare_part_id = s.id
            WHERE p.machine_id = $1
            ORDER BY p.id DESC
        `, [req.params.machineId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/plans', upload.single('image'), async (req, res) => {
    try {
        const { machine_id, task_name, next_due_date, interval_months, spare_part_id, notes } = req.body;
        const image_url = req.file ? `/uploads/${req.file.filename}` : null;
        
        await db.query(`
            INSERT INTO plans (machine_id, task_name, next_due_date, interval_months, spare_part_id, notes, image_url, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'รอดำเนินการ')
        `, [machine_id, task_name, next_due_date, interval_months, spare_part_id || null, notes, image_url]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.patch('/api/plans/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const { id } = req.params;

        if (status === 'เสร็จสิ้น') {
            const { rows } = await db.query('SELECT spare_part_id FROM plans WHERE id = $1', [id]);
            const plan = rows[0];
            if (plan && plan.spare_part_id) {
                await db.query('UPDATE spare_parts SET stock_qty = GREATEST(0, stock_qty - 1) WHERE id = $1', [plan.spare_part_id]);
            }
        }

        await db.query('UPDATE plans SET status = $1 WHERE id = $2', [status, id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/plans/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM plans WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ====================================================
// 4. BREAKDOWN HISTORY API
// ====================================================

app.get('/api/breakdowns', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT b.*, m.name as machine_name 
            FROM breakdowns b
            JOIN machines m ON b.machine_id = m.id
            ORDER BY b.breakdown_date DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/breakdowns', async (req, res) => {
    try {
        const { machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause } = req.body;
        await db.query(`
            INSERT INTO breakdowns (machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/breakdowns/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM breakdowns WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ====================================================
// 5. SPARE PARTS API
// ====================================================

app.get('/api/spare-parts', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM spare_parts ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/spare-parts', async (req, res) => {
    try {
        const { part_name, stock_qty, min_qty } = req.body;
        await db.query('INSERT INTO spare_parts (part_name, stock_qty, min_qty) VALUES ($1, $2, $3)', [part_name, stock_qty, min_qty]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/spare-parts/:id', async (req, res) => {
    try {
        const { part_name, stock_qty, min_qty } = req.body;
        await db.query('UPDATE spare_parts SET part_name = $1, stock_qty = $2, min_qty = $3 WHERE id = $4', [part_name, stock_qty, min_qty, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/spare-parts/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM spare_parts WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});