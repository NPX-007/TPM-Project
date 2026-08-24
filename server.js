const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// สร้างตารางฐานข้อมูลทั้งหมด
async function initDB() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS Users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT,
            role TEXT DEFAULT 'staff' -- admin, engineer, staff
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS Machines (
            id SERIAL PRIMARY KEY, 
            name TEXT, 
            location TEXT
        )`);
        
        await pool.query(`CREATE TABLE IF NOT EXISTS TPM_Plans (
            id SERIAL PRIMARY KEY, 
            machine_id INTEGER, 
            task_name TEXT, 
            next_due_date TEXT,
            completed_date TEXT,
            interval_months INTEGER DEFAULT 0,
            status TEXT DEFAULT 'รอดำเนินการ',
            notes TEXT,
            image_url TEXT
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS Breakdowns (
            id SERIAL PRIMARY KEY,
            machine_id INTEGER,
            breakdown_date TEXT,
            symptom TEXT,
            cause TEXT,
            downtime_hours NUMERIC,
            repair_cost NUMERIC,
            status TEXT DEFAULT 'กำลังซ่อม'
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS SpareParts (
            id SERIAL PRIMARY KEY,
            part_name TEXT,
            stock_qty INTEGER DEFAULT 0,
            min_qty INTEGER DEFAULT 5
        )`);

        // สร้าง Admin เริ่มต้นถ้ายังไม่มี
        const adminCheck = await pool.query("SELECT * FROM Users WHERE username = 'admin'");
        if (adminCheck.rows.length === 0) {
            await pool.query("INSERT INTO Users (username, password, role) VALUES ('admin', '1234', 'admin')");
            console.log("👤 สร้างบัญชีเริ่มต้น Admin (user: admin, pass: 1234) สำเร็จ");
        }

        console.log("✅ สร้าง/ตรวจสอบตารางฐานข้อมูลทั้งหมดสำเร็จ");
    } catch (err) {
        console.error("❌ เกิดข้อผิดพลาดในการสร้างตาราง:", err);
    }
}
initDB();

// --- API: Authentication ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query("SELECT * FROM Users WHERE username = $1 AND password = $2", [username, password]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            res.json({ success: true, role: user.role, username: user.username });
        } else {
            res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API: Machines ---
app.get('/api/machines', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM Machines ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/machines', async (req, res) => {
    const { name, location } = req.body;
    try {
        const result = await pool.query(
            "INSERT INTO Machines (name, location) VALUES ($1, $2) RETURNING id",
            [name, location]
        );
        res.json({ id: result.rows[0].id, name, location });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/machines/:id', async (req, res) => {
    const { id } = req.params;
    const { name, location } = req.body;
    try {
        await pool.query("UPDATE Machines SET name = $1, location = $2 WHERE id = $3", [name, location, id]);
        res.json({ success: true, id, name, location });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/machines/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM TPM_Plans WHERE machine_id = $1", [id]);
        await pool.query("DELETE FROM Breakdowns WHERE machine_id = $1", [id]);
        await pool.query("DELETE FROM Machines WHERE id = $1", [id]);
        res.json({ success: true, message: 'ลบเครื่องจักรสำเร็จ' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- API: Plans ---
app.get('/api/plans/:machine_id', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM TPM_Plans WHERE machine_id = $1 AND status != 'เสร็จสิ้น'",
            [req.params.machine_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/all-plans', async (req, res) => {
    const sql = `SELECT t.*, m.name as machine_name, m.location 
                 FROM TPM_Plans t 
                 JOIN Machines m ON t.machine_id = m.id 
                 WHERE t.status != 'เสร็จสิ้น'
                 ORDER BY t.next_due_date ASC`;
    try {
        const result = await pool.query(sql);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/completed-history', async (req, res) => {
    const sql = `SELECT t.*, m.name as machine_name, m.location 
                 FROM TPM_Plans t 
                 JOIN Machines m ON t.machine_id = m.id 
                 WHERE t.status = 'เสร็จสิ้น' 
                 ORDER BY t.completed_date DESC, t.next_due_date DESC`;
    try {
        const result = await pool.query(sql);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/plans', upload.single('image'), async (req, res) => {
    const { machine_id, task_name, next_due_date, interval_months, status, notes } = req.body;
    const taskStatus = status || 'รอดำเนินการ';
    const interval = parseInt(interval_months) || 0;
    const image_url = req.file ? `/uploads/${req.file.filename}` : null;
    
    try {
        const result = await pool.query(
            `INSERT INTO TPM_Plans (machine_id, task_name, next_due_date, interval_months, status, notes, image_url) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [machine_id, task_name, next_due_date, interval, taskStatus, notes, image_url]
        );
        res.json({ id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function calculateNextDueDate(currentDateStr, months) {
    const date = new Date(currentDateStr);
    date.setMonth(date.getMonth() + parseInt(months));
    return date.toISOString().split('T')[0];
}

app.patch('/api/plans/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    try {
        const oldPlanResult = await pool.query("SELECT * FROM TPM_Plans WHERE id = $1", [id]);
        const oldPlan = oldPlanResult.rows[0];
        if (!oldPlan) return res.status(404).json({ success: false, message: 'ไม่พบแผนงาน' });

        const interval = parseInt(oldPlan.interval_months) || 0;

        if (status === 'เสร็จสิ้น') {
            const todayStr = new Date().toISOString().split('T')[0];
            await pool.query("UPDATE TPM_Plans SET status = 'เสร็จสิ้น', completed_date = $1 WHERE id = $2", [todayStr, id]);

            if (interval > 0) {
                const nextDate = calculateNextDueDate(todayStr, interval);
                await pool.query(
                    `INSERT INTO TPM_Plans (machine_id, task_name, next_due_date, interval_months, status, notes, image_url) 
                     VALUES ($1, $2, $3, $4, 'รอดำเนินการ', $5, $6)`,
                    [oldPlan.machine_id, oldPlan.task_name, nextDate, interval, oldPlan.notes, oldPlan.image_url]
                );
            }
            res.json({ success: true });
        } else {
            await pool.query("UPDATE TPM_Plans SET status = $1 WHERE id = $2", [status, id]);
            res.json({ success: true });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/plans/:id', upload.single('image'), async (req, res) => {
    const { id } = req.params;
    const { task_name, next_due_date, interval_months, status, notes } = req.body;
    const interval = parseInt(interval_months) || 0;

    try {
        const oldPlanResult = await pool.query("SELECT * FROM TPM_Plans WHERE id = $1", [id]);
        const oldPlan = oldPlanResult.rows[0];

        const updateAction = async (imgUrl) => {
            let todayStr = new Date().toISOString().split('T')[0];
            let actualImgUrl = imgUrl || (oldPlan ? oldPlan.image_url : null);
            let completedDateVal = status === 'เสร็จสิ้น' ? todayStr : (oldPlan ? oldPlan.completed_date : null);

            await pool.query(
                `UPDATE TPM_Plans SET task_name = $1, next_due_date = $2, interval_months = $3, status = $4, notes = $5, completed_date = $6, image_url = $7 WHERE id = $8`,
                [task_name, next_due_date, interval, status, notes, completedDateVal, actualImgUrl, id]
            );

            if (status === 'เสร็จสิ้น' && oldPlan && oldPlan.status !== 'เสร็จสิ้น' && interval > 0) {
                const nextDate = calculateNextDueDate(todayStr, interval);
                await pool.query(
                    `INSERT INTO TPM_Plans (machine_id, task_name, next_due_date, interval_months, status, notes, image_url) 
                     VALUES ($1, $2, $3, $4, 'รอดำเนินการ', $5, $6)`,
                    [oldPlan.machine_id, task_name, nextDate, interval, notes, actualImgUrl]
                );
            }
            res.json({ success: true });
        };

        if (req.file) {
            await updateAction(`/uploads/${req.file.filename}`);
        } else {
            await updateAction(null);
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/plans/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM TPM_Plans WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API: Breakdowns (ประวัติเครื่องจักรเสีย) ---
app.get('/api/breakdowns', async (req, res) => {
    const sql = `SELECT b.*, m.name as machine_name, m.location 
                 FROM Breakdowns b 
                 JOIN Machines m ON b.machine_id = m.id 
                 ORDER BY b.breakdown_date DESC`;
    try {
        const result = await pool.query(sql);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/breakdowns', async (req, res) => {
    const { machine_id, breakdown_date, symptom, cause, downtime_hours, repair_cost, status } = req.body;
    try {
        await pool.query(
            `INSERT INTO Breakdowns (machine_id, breakdown_date, symptom, cause, downtime_hours, repair_cost, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [machine_id, breakdown_date, symptom, cause, parseFloat(downtime_hours) || 0, parseFloat(repair_cost) || 0, status || 'กำลังซ่อม']
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/breakdowns/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM Breakdowns WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API: Spare Parts (คลังอะไหล่) ---
app.get('/api/spare-parts', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM SpareParts ORDER BY id DESC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/spare-parts', async (req, res) => {
    const { part_name, stock_qty, min_qty } = req.body;
    try {
        await pool.query(
            "INSERT INTO SpareParts (part_name, stock_qty, min_qty) VALUES ($1, $2, $3)",
            [part_name, parseInt(stock_qty) || 0, parseInt(min_qty) || 5]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/spare-parts/:id', async (req, res) => {
    const { id } = req.params;
    const { part_name, stock_qty, min_qty } = req.body;
    try {
        await pool.query(
            "UPDATE SpareParts SET part_name = $1, stock_qty = $2, min_qty = $3 WHERE id = $4",
            [part_name, parseInt(stock_qty) || 0, parseInt(min_qty) || 5, id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/spare-parts/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM SpareParts WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API: Dashboard Summary ---
app.get('/api/dashboard-summary', async (req, res) => {
    try {
        const plansRes = await pool.query("SELECT status, count(*) FROM TPM_Plans GROUP BY status");
        const breakdownRes = await pool.query("SELECT sum(downtime_hours) as total_downtime, sum(repair_cost) as total_cost FROM Breakdowns");
        const spareRes = await pool.query("SELECT count(*) as low_stock FROM SpareParts WHERE stock_qty <= min_qty");

        res.json({
            plans: plansRes.rows,
            downtime: breakdownRes.rows[0].total_downtime || 0,
            repairCost: breakdownRes.rows[0].total_cost || 0,
            lowStockCount: spareRes.rows[0].low_stock || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ เซิร์ฟเวอร์ทำงานแล้วที่พอร์ต ${PORT}`));