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
    destination: (req, file, cb) => cb(null, uploadDir),
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
        console.error('Login Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

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
        console.error('Register Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT id, username, role FROM users ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        console.error('Get Users Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.patch('/api/users/:id/role', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { role } = req.body;
        await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
        res.json({ success: true, message: 'อัปเดตสิทธิ์ผู้ใช้เรียบร้อยแล้ว' });
    } catch (err) {
        console.error('Update Role Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await db.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true, message: 'ลบบัญชีผู้ใช้งานเรียบร้อยแล้ว' });
    } catch (err) {
        console.error('Delete User Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.patch('/api/users/profile', async (req, res) => {
    try {
        const { userId, oldPassword, newUsername, newPassword } = req.body;
        const parsedUserId = parseInt(userId);
        
        if (newPassword) {
            const { rows: check } = await db.query(
                'SELECT id FROM users WHERE id = $1 AND password = $2',
                [parsedUserId, oldPassword]
            );
            if (check.length === 0) {
                return res.json({ success: false, message: 'รหัสผ่านเดิมไม่ถูกต้อง' });
            }
            await db.query(
                'UPDATE users SET username = $1, password = $2 WHERE id = $3',
                [newUsername, newPassword, parsedUserId]
            );
        } else {
            await db.query(
                'UPDATE users SET username = $1 WHERE id = $2',
                [newUsername, parsedUserId]
            );
        }

        const { rows: updated } = await db.query(
            'SELECT id, username, role FROM users WHERE id = $1',
            [parsedUserId]
        );
        res.json({ success: true, message: 'แก้ไขข้อมูลส่วนตัวสำเร็จ', user: updated[0] });
    } catch (err) {
        console.error('Update Profile Error:', err);
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
            downtime: Number(bdSum.downtime || 0),
            repairCost: Number(bdSum.repairCost || 0),
            lowStockCount: Number(lowStock.lowStockCount || 0),
            plans: plans || []
        });
    } catch (err) {
        console.error('Dashboard Summary Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/machines', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM machines ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        console.error('Get Machines Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/machines', async (req, res) => {
    try {
        const { name, location } = req.body;
        await db.query('INSERT INTO machines (name, location) VALUES ($1, $2)', [name, location]);
        res.json({ success: true });
    } catch (err) {
        console.error('Add Machine Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/machines/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await db.query('DELETE FROM breakdowns WHERE machine_id = $1', [id]);
        await db.query('DELETE FROM plans WHERE machine_id = $1', [id]);
        await db.query('DELETE FROM machines WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete Machine Error:', err);
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
            WHERE p.status != 'เสร็จสิ้น'
            ORDER BY p.next_due_date ASC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Get Master Plans Error:', err);
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
        console.error('Get Overdue Plans Error:', err);
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
            ORDER BY p.actual_date DESC, p.id DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Get History Plans Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/plans/:machineId', async (req, res) => {
    try {
        const machineId = parseInt(req.params.machineId);
        if (isNaN(machineId)) return res.json([]);

        const { rows } = await db.query(`
            SELECT p.*, s.part_name as spare_part_name 
            FROM plans p
            LEFT JOIN spare_parts s ON p.spare_part_id = s.id
            WHERE p.machine_id = $1 AND p.status != 'เสร็จสิ้น'
            ORDER BY p.id DESC
        `, [machineId]);
        res.json(rows);
    } catch (err) {
        console.error('Get Machine Plans Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/plans', upload.single('image'), async (req, res) => {
    try {
        const { machine_id, task_name, next_due_date, interval_months, spare_part_id, notes } = req.body;
        const image_url = req.file ? `/uploads/${req.file.filename}` : null;
        
        const parsedMachineId = parseInt(machine_id);
        const parsedIntervalRaw = parseInt(interval_months);
        const parsedInterval = Number.isNaN(parsedIntervalRaw) ? 1 : parsedIntervalRaw;
        const parsedSparePartId = (spare_part_id && spare_part_id !== '' && spare_part_id !== 'null' && spare_part_id !== 'undefined') 
            ? parseInt(spare_part_id) 
            : null;
        const cleanNotes = (notes && notes.trim() !== '') ? notes : null;

        await db.query(`
            INSERT INTO plans (machine_id, task_name, next_due_date, interval_months, spare_part_id, notes, image_url, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'รอดำเนินการ')
        `, [parsedMachineId, task_name, next_due_date, parsedInterval, parsedSparePartId, cleanNotes, image_url]);

        res.json({ success: true });
    } catch (err) {
        console.error('Add Plan Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// แก้ไขรายละเอียดงานแผน TPM (ไม่กระทบสถานะ/วันที่เสร็จจริง)
app.put('/api/plans/:id', upload.single('image'), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { task_name, next_due_date, interval_months, spare_part_id, notes } = req.body;

        const parsedIntervalRaw = parseInt(interval_months);
        const parsedInterval = Number.isNaN(parsedIntervalRaw) ? 1 : parsedIntervalRaw;
        const parsedSparePartId = (spare_part_id && spare_part_id !== '' && spare_part_id !== 'null' && spare_part_id !== 'undefined')
            ? parseInt(spare_part_id)
            : null;
        const cleanNotes = (notes && notes.trim() !== '') ? notes : null;

        if (req.file) {
            const image_url = `/uploads/${req.file.filename}`;
            await db.query(`
                UPDATE plans SET task_name = $1, next_due_date = $2, interval_months = $3, spare_part_id = $4, notes = $5, image_url = $6
                WHERE id = $7
            `, [task_name, next_due_date, parsedInterval, parsedSparePartId, cleanNotes, image_url, id]);
        } else {
            await db.query(`
                UPDATE plans SET task_name = $1, next_due_date = $2, interval_months = $3, spare_part_id = $4, notes = $5
                WHERE id = $6
            `, [task_name, next_due_date, parsedInterval, parsedSparePartId, cleanNotes, id]);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Update Plan Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// อัปเดตสถานะงาน / ยืนยันทำเสร็จ แล้วคำนวณวันรอบถัดไปอัตโนมัติ
app.patch('/api/plans/:id/status', async (req, res) => {
    const client = await db.connect();
    try {
        await client.query('BEGIN'); // ใช้ Transaction เพื่อความถูกต้องของข้อมูล
        const { status, actual_date } = req.body;
        const id = parseInt(req.params.id);

        if (status === 'เสร็จสิ้น') {
            // 1. ดึงข้อมูลแผนเดิมขึ้นมา
            const { rows } = await client.query('SELECT * FROM plans WHERE id = $1', [id]);
            const plan = rows[0];

            if (plan) {
                // 2. ตัดสต็อกอะไหล่ (ถ้ามีการระบุ)
                if (plan.spare_part_id) {
                    await client.query('UPDATE spare_parts SET stock_qty = GREATEST(0, stock_qty - 1) WHERE id = $1', [plan.spare_part_id]);
                }

                const actualDateStr = actual_date || new Date().toISOString().split('T')[0];

                // 3. เปลี่ยนสถานะรายการนี้เป็น 'เสร็จสิ้น' พร้อมบันทึกวันเสร็จจริง (เพื่อให้อยู่ในตารางประวัติ)
                await client.query('UPDATE plans SET status = $1, actual_date = $2 WHERE id = $3', [status, actualDateStr, id]);

                // 4. ถ้ามีรอบซ้ำ (interval_months > 0) ให้สร้างงานรอบถัดไปโดยนับจากวันที่เสร็จจริง
                //    ถ้าไม่มีรอบซ้ำ (interval_months = 0) จะไม่สร้างงานใหม่ - งานนี้จะหายไปจาก Master Plan
                //    และเหลือแค่บันทึกไว้ในประวัติงานเสร็จเท่านั้น
                const intervalMonths = parseInt(plan.interval_months) || 0;
                if (intervalMonths > 0) {
                    const nextDueDate = new Date(actualDateStr);
                    nextDueDate.setMonth(nextDueDate.getMonth() + intervalMonths);
                    const nextDueDateStr = nextDueDate.toISOString().split('T')[0];

                    // 5. บันทึกงานรายการใหม่เข้าตารางเพื่อเริ่มนับรอบถัดไป (สถานะ 'รอดำเนินการ')
                    await client.query(`
                        INSERT INTO plans (machine_id, task_name, next_due_date, interval_months, spare_part_id, notes, image_url, status)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, 'รอดำเนินการ')
                    `, [
                        plan.machine_id,
                        plan.task_name,
                        nextDueDateStr,
                        intervalMonths,
                        plan.spare_part_id,
                        plan.notes,
                        plan.image_url
                    ]);
                }
            }
        } else {
            // ถ้ายกเลิกหรือย้อนกลับสถานะ
            await client.query('UPDATE plans SET status = $1, actual_date = NULL WHERE id = $2', [status, id]);
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Update Plan Status Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/plans/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await db.query('DELETE FROM plans WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete Plan Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/plans/bulk-delete', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.json({ success: false, message: 'กรุณาเลือกรายการที่ต้องการลบ' });
        }
        await db.query('DELETE FROM plans WHERE id = ANY($1::int[])', [ids]);
        res.json({ success: true, message: 'ลบรายการที่เลือกเรียบร้อยแล้ว' });
    } catch (err) {
        console.error('Bulk Delete Plans Error:', err);
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
        console.error('Get Breakdowns Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/breakdowns', async (req, res) => {
    try {
        const { machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause } = req.body;
        
        const parsedMachineId = parseInt(machine_id);
        const parsedDowntime = parseFloat(downtime_hours) || 0;
        const parsedRepairCost = parseFloat(repair_cost) || 0;
        const cleanSymptom = (symptom && symptom.trim() !== '') ? symptom : null;
        const cleanCause = (cause && cause.trim() !== '') ? cause : null;

        await db.query(`
            INSERT INTO breakdowns (machine_id, breakdown_date, downtime_hours, repair_cost, symptom, cause)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [parsedMachineId, breakdown_date, parsedDowntime, parsedRepairCost, cleanSymptom, cleanCause]);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Add Breakdown Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/breakdowns/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await db.query('DELETE FROM breakdowns WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete Breakdown Error:', err);
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
        console.error('Get Spare Parts Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/spare-parts', async (req, res) => {
    try {
        const { part_name, stock_qty, min_qty } = req.body;
        
        const parsedStock = parseInt(stock_qty) || 0;
        const parsedMin = parseInt(min_qty) || 0;

        await db.query('INSERT INTO spare_parts (part_name, stock_qty, min_qty) VALUES ($1, $2, $3)', [part_name, parsedStock, parsedMin]);
        res.json({ success: true });
    } catch (err) {
        console.error('Add Spare Part Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/spare-parts/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { part_name, stock_qty, min_qty } = req.body;
        
        const parsedStock = parseInt(stock_qty) || 0;
        const parsedMin = parseInt(min_qty) || 0;

        await db.query('UPDATE spare_parts SET part_name = $1, stock_qty = $2, min_qty = $3 WHERE id = $4', [part_name, parsedStock, parsedMin, id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Update Spare Part Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/spare-parts/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await db.query('UPDATE plans SET spare_part_id = NULL WHERE spare_part_id = $1', [id]);
        await db.query('DELETE FROM spare_parts WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete Spare Part Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});