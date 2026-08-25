const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL Connection Setup
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
// Database Initialization Setup
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
        console.log('✅ Database setup complete.');
    } catch (err) {
        console.error('❌ Database Initialization Error:', err);
    }
};
initDb();

// ----------------------------------------------------
// API Routes
// ----------------------------------------------------

// 1. ดึงข้อมูลเครื่องจักรทั้งหมด
app.get('/api/machines', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM machines ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. ดึงข้อมูลอะไหล่ทั้งหมด
app.get('/api/spare-parts', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM spare_parts ORDER BY id ASC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. ดึงแผน TPM (รองรับการกรองตาม machine_id)
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

// 4. ดึงประวัติงานที่เสร็จสิ้นทั้งหมด
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

// 5. อัปเดตสถานะงาน (กรณี "เสร็จสิ้น" -> บันทึกประวัติ + ตัดสต็อก + บวกวันรอบใหม่ + รีเซ็ตเป็น "รอดำเนินการ")
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

            // 1) บันทึกลงตาราง plan_history
            await client.query(`
                INSERT INTO plan_history (machine_id, task_name, interval_months, spare_part_id, completed_date, notes, image_url)
                VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6)
            `, [
                plan.machine_id,
                plan.task_name,
                plan.interval_months,
                plan.spare_part_id,
                plan.notes,
                plan.image_url
            ]);

            // 2) ตัดสต็อกอะไหล่ (ถ้ามีการผูกอะไหล่ไว้)
            if (plan.spare_part_id) {
                await client.query(`
                    UPDATE spare_parts 
                    SET stock_qty = GREATEST(0, stock_qty - 1) 
                    WHERE id = $1
                `, [plan.spare_part_id]);
            }

            // 3) คำนวณวันกำหนดรอบถัดไป และรีเซ็ตสถานะกลับเป็น "รอดำเนินการ"
            await client.query(`
                UPDATE plans 
                SET next_due_date = (next_due_date + (interval_months || ' month')::interval)::date,
                    status = 'รอดำเนินการ'
                WHERE id = $1
            `, [id]);

            await client.query('COMMIT');
            return res.json({ 
                success: true, 
                isReset: true, 
                message: 'บันทึกประวัติ ตัดสต็อก และตั้งวันรอบถัดไปเรียบร้อยแล้ว' 
            });
        }

        // กรณีเปลี่ยนสถานะอื่นๆ (เช่น "รออะไหล่")
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

// เริ่มทำงาน Web Server
app.listen(port, () => {
    console.log(`🚀 Server running on http://localhost:${port}`);
});