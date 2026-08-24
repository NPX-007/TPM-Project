const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
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

const db = new sqlite3.Database('./tpm.db');
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS Machines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, location TEXT)");
    db.run(`CREATE TABLE IF NOT EXISTS TPM_Plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        machine_id INTEGER, 
        task_name TEXT, 
        next_due_date TEXT,
        completed_date TEXT,
        interval_months INTEGER DEFAULT 0,
        status TEXT DEFAULT 'รอดำเนินการ',
        notes TEXT,
        image_url TEXT
    )`, (err) => {
        db.run("ALTER TABLE TPM_Plans ADD COLUMN completed_date TEXT", () => {});
        db.run("ALTER TABLE TPM_Plans ADD COLUMN interval_months INTEGER DEFAULT 0", () => {});
    });
});

// --- API Machines ---
app.get('/api/machines', (req, res) => {
    db.all("SELECT * FROM Machines", [], (err, rows) => res.json(rows));
});

app.post('/api/machines', (req, res) => {
    const { name, location } = req.body;
    db.run("INSERT INTO Machines (name, location) VALUES (?, ?)", [name, location], function(err) {
        res.json({ id: this.lastID, name, location });
    });
});

// แก้ไขชื่อเครื่องจักร
app.put('/api/machines/:id', (req, res) => {
    const { id } = req.params;
    const { name, location } = req.body;
    db.run("UPDATE Machines SET name = ?, location = ? WHERE id = ?", [name, location, id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, id, name, location });
    });
});

// เพิ่มส่วนนี้: API สำหรับลบเครื่องจักร (และลบแผน TPM ที่ผูกอยู่ด้วยกัน)
app.delete('/api/machines/:id', (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM TPM_Plans WHERE machine_id = ?", [id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        db.run("DELETE FROM Machines WHERE id = ?", [id], function(err2) {
            if (err2) return res.status(500).json({ success: false, error: err2.message });
            res.json({ success: true, message: 'ลบเครื่องจักรสำเร็จ' });
        });
    });
});

// --- API Plans ---
app.get('/api/plans/:machine_id', (req, res) => {
    db.all("SELECT * FROM TPM_Plans WHERE machine_id = ? AND status != 'เสร็จสิ้น'", [req.params.machine_id], (err, rows) => res.json(rows));
});

app.get('/api/all-plans', (req, res) => {
    const sql = `SELECT t.*, m.name as machine_name, m.location 
                 FROM TPM_Plans t 
                 JOIN Machines m ON t.machine_id = m.id 
                 WHERE t.status != 'เสร็จสิ้น'
                 ORDER BY t.next_due_date ASC`;
    db.all(sql, [], (err, rows) => res.json(rows));
});

app.get('/api/completed-history', (req, res) => {
    const sql = `SELECT t.*, m.name as machine_name, m.location 
                 FROM TPM_Plans t 
                 JOIN Machines m ON t.machine_id = m.id 
                 WHERE t.status = 'เสร็จสิ้น' 
                 ORDER BY t.completed_date DESC, t.next_due_date DESC`;
    db.all(sql, [], (err, rows) => res.json(rows));
});

app.post('/api/plans', upload.single('image'), (req, res) => {
    const { machine_id, task_name, next_due_date, interval_months, status, notes } = req.body;
    const taskStatus = status || 'รอดำเนินการ';
    const interval = parseInt(interval_months) || 0;
    const image_url = req.file ? `/uploads/${req.file.filename}` : null;
    
    db.run("INSERT INTO TPM_Plans (machine_id, task_name, next_due_date, interval_months, status, notes, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)", 
        [machine_id, task_name, next_due_date, interval, taskStatus, notes, image_url], function(err) {
        res.json({ id: this.lastID });
    });
});

function calculateNextDueDate(currentDateStr, months) {
    const date = new Date(currentDateStr);
    date.setMonth(date.getMonth() + parseInt(months));
    return date.toISOString().split('T')[0];
}

app.patch('/api/plans/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    db.get("SELECT * FROM TPM_Plans WHERE id = ?", [id], (err, oldPlan) => {
        if (!oldPlan) return res.status(404).json({ success: false, message: 'ไม่พบแผนงาน' });

        const interval = parseInt(oldPlan.interval_months) || 0;

        if (status === 'เสร็จสิ้น') {
            const todayStr = new Date().toISOString().split('T')[0];
            db.run("UPDATE TPM_Plans SET status = 'เสร็จสิ้น', completed_date = ? WHERE id = ?", [todayStr, id], function(err) {
                if (err) return res.status(500).json({ success: false });

                if (interval > 0) {
                    const nextDate = calculateNextDueDate(todayStr, interval);
                    db.run("INSERT INTO TPM_Plans (machine_id, task_name, next_due_date, interval_months, status, notes, image_url) VALUES (?, ?, ?, ?, 'รอดำเนินการ', ?, ?)",
                        [oldPlan.machine_id, oldPlan.task_name, nextDate, interval, oldPlan.notes, oldPlan.image_url]);
                }
                res.json({ success: true });
            });
        } else {
            db.run("UPDATE TPM_Plans SET status = ? WHERE id = ?", [status, id], function(err) {
                res.json({ success: true });
            });
        }
    });
});

app.put('/api/plans/:id', upload.single('image'), (req, res) => {
    const { id } = req.params;
    const { task_name, next_due_date, interval_months, status, notes } = req.body;
    const interval = parseInt(interval_months) || 0;

    db.get("SELECT * FROM TPM_Plans WHERE id = ?", [id], (err, oldPlan) => {
        const updateAction = (imgUrl) => {
            let sql = `UPDATE TPM_Plans SET task_name = ?, next_due_date = ?, interval_months = ?, status = ?, notes = ?`;
            let params = [task_name, next_due_date, interval, status, notes];
            
            let todayStr = new Date().toISOString().split('T')[0];
            if (status === 'เสร็จสิ้น') {
                sql += `, completed_date = ?`;
                params.push(todayStr);
            }

            if (imgUrl) {
                sql += `, image_url = ?`;
                params.push(imgUrl);
            }
            sql += ` WHERE id = ?`;
            params.push(id);

            db.run(sql, params, function(err) {
                if (status === 'เสร็จสิ้น' && oldPlan && oldPlan.status !== 'เสร็จสิ้น' && interval > 0) {
                    const nextDate = calculateNextDueDate(todayStr, interval);
                    db.run("INSERT INTO TPM_Plans (machine_id, task_name, next_due_date, interval_months, status, notes, image_url) VALUES (?, ?, ?, ?, 'รอดำเนินการ', ?, ?)",
                        [oldPlan.machine_id, task_name, nextDate, interval, notes, imgUrl || oldPlan.image_url]);
                }
                res.json({ success: true });
            });
        };

        if (req.file) {
            updateAction(`/uploads/${req.file.filename}`);
        } else {
            updateAction(null);
        }
    });
});

app.delete('/api/plans/:id', (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM TPM_Plans WHERE id = ?", [id], function(err) {
        res.json({ success: true });
    });
});

app.listen(3000, () => console.log('✅ เซิร์ฟเวอร์ทำงานแล้วที่ http://localhost:3000'));