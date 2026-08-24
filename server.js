const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// ตั้งค่าการเชื่อมต่อฐานข้อมูล (รองรับทั้ง DATABASE_URL บน Render และเชื่อมต่อทั่วไป)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // สมมติว่าไฟล์หน้าเว็บอยู่ในโฟลเดอร์ public หรือ root

// ฟังก์ชันสร้างตารางและบัญชี Admin อัตโนมัติเมื่อเริ่มระบบ
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL
            );
        `);

        // ตรวจสอบว่ามี admin หรือยัง ถ้ายังให้สร้างอัตโนมัติ
        const checkAdmin = await pool.query("SELECT * FROM users WHERE username = 'admin'");
        if (checkAdmin.rows.length === 0) {
            await pool.query(
                "INSERT INTO users (username, password, role) VALUES ($1, $2, $3)",
                ['admin', '1234', 'admin']
            );
            console.log('✅ สร้างบัญชีผู้ใช้เริ่มต้น (admin / 1234) เรียบร้อยแล้ว');
        }

        console.log('✅ ตรวจสอบและสร้างตารางฐานข้อมูลสำเร็จ');
    } catch (err) {
        console.error('❌ เกิดข้อผิดพลาดในการสร้างตาราง:', err);
    }
}

initDB();

// API สำหรับเข้าสู่ระบบ (Login)
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

// เริ่มต้นรันเซิร์ฟเวอร์
app.listen(port, () => {
    console.log(`✅ เซิร์ฟเวอร์ทำงานแล้วที่พอร์ต ${port}`);
});