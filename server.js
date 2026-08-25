const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

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
        console.log('✅ Initialized Database Tables Successfully');
    } catch (err) {
        console.error('❌ Database Initialization Error:', err);
    }
};
initDb();

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. Dashboard Summaries
app.get('/api/dashboard', async (req, res) => {
    try {
        const machinesCount = await pool.query('SELECT COUNT(*) FROM machines');
        const pendingCount = await pool.query("SELECT COUNT(*) FROM plans WHERE status = 'รอดำเนินการ'");
        const overdueCount = await pool.query("SELECT COUNT(*) FROM plans WHERE next_due_date < CURRENT_DATE AND status != 'เสร็จสิ้น'");
        const lowStockCount = await pool.query('SELECT COUNT(*) FROM spare_parts WHERE stock_qty <= 2');

        res.json({
            totalMachines: parseInt(machinesCount.rows[0].count),
            pendingPlans: parseInt(pendingCount.rows[0].count),
            overduePlans: parseInt(overdueCount.rows[0].count),
            lowStockParts: parseInt(lowStockCount.rows[0].count)
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. Machine Management API
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

// 3. Spare Parts Management API
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

// 4. Plans API (รองรับการ Filter ตาม Machine ID)
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

// 5. Overdue Plans API (แผนงานที่เลยกำหนด)
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

// 6. Add/Edit/Delete Plans
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

// 7. Plan History API
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

// 8. Update Plan Status (ฟังก์ชันเปลี่ยนสถานะเสร็จสิ้น -> ย้ายเข้า History + ตัดสต็อก + ตั้งรอบใหม่)
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

            // บันทึกประวัติลงตาราง plan_history
            await client.query(`
                INSERT INTO plan_history (machine_id, task_name, interval_months, spare_part_id, completed_date, notes, image_url)
                VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6)
            `, [plan.machine_id, plan.task_name, plan.interval_months, plan.spare_part_id, plan.notes, plan.image_url]);

            // ตัดสต็อกอะไหล่ (ถ้ามี)
            if (plan.spare_part_id) {
                await client.query('UPDATE spare_parts SET stock_qty = GREATEST(0, stock_qty - 1) WHERE id = $1', [plan.spare_part_id]);
            }

            // คำนวณวันกำหนดรอบถัดไป และรีเซ็ตสถานะกลับเป็น "รอดำเนินการ"
            await client.query(`
                UPDATE plans 
                SET next_due_date = (next_due_date + (interval_months || ' month')::interval)::date,
                    status = 'รอดำเนินการ'
                WHERE id = $1
            `, [id]);

            await client.query('COMMIT');
            return res.json({ success: true, isReset: true, message: 'บันทึกประวัติ ตัดสต็อก และตั้งวันรอบถัดไปเรียบร้อยแล้ว' });
        }

        // สถานะอื่นๆ (เช่น "รออะไหล่")
        await client.query('UPDATE plans SET status = $1 WHERE id = $2', [status, id]);
        await client.query('COMMIT');
        res.json({ success: true, isReset: false });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Update Status Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

app.listen(port, () => {
    console.log(`🚀 TPM Server is running on port ${port}`);
});