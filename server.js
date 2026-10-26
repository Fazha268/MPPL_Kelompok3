require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Inisialisasi Google Gen AI menggunakan Environment Variable (.env)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Konfigurasi Database SQLite
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) console.error('Gagal terhubung ke SQLite:', err.message);
  else console.log('Berhasil terhubung ke database SQLite.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL,
    kelas TEXT NOT NULL,
    total_poin INTEGER DEFAULT 0
  )`);
});

// Konfigurasi Multer Upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// --- ENDPOINT API ---

// 1. Endpoint Login / Register
app.post('/api/login', (req, res) => {
  const { nama, kelas } = req.body;
  if (!nama || !kelas) return res.status(400).json({ success: false, message: 'Nama dan kelas wajib diisi.' });

  db.get('SELECT * FROM users WHERE nama = ? AND kelas = ?', [nama, kelas], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (row) {
      res.json({ success: true, data: row });
    } else {
      db.run('INSERT INTO users (nama, kelas, total_poin) VALUES (?, ?, 0)', [nama, kelas], function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, data: { id: this.lastID, nama, kelas, total_poin: 0 } });
      });
    }
  });
});

// 2. Endpoint Leaderboard
app.get('/api/leaderboard', (req, res) => {
  db.all('SELECT id, nama, kelas, total_poin FROM users ORDER BY total_poin DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json(rows);
  });
});

// 3. Endpoint Smart Scan AI (Super Akurat, Presisi Objek Asli & Aman Parsing)
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    const userId = req.body.user_id;
    if (!userId || !req.file) {
      return res.status(400).json({ success: false, message: 'Data foto atau user_id tidak ditemukan.' });
    }

    const filePath = req.file.path;
    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    let aiResult;

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        config: {
          temperature: 0.1,
          systemInstruction: `Anda adalah sistem AI computer vision dan pakar pengolahan sampah profesional yang sangat teliti. 
Tugas mutlak Anda adalah mengenali objek fisik apa adanya yang terlihat di dalam foto secara SANGAT SPESIFIK (contoh: Botol Plastik Air Mineral, Kardus E-Commerce, Sisa Makanan/Nasi, Baterai Bekas, Minyak Jelantah, Popok Bayi, Kaleng Soda, Pecahan Kaca, Kain Perca, dll). Dilarang menebak secara asal atau menyamaratakan ke kategori umum.`
        },
        contents: [
          {
            inlineData: {
              data: base64Image,
              mimeType: mimeType
            }
          },
          {
            text: `Analisis foto sampah ini secara cermat. Tentukan nama benda secara spesifik sesuai bentuk aslinya di foto.
Pilih kategori utama yang tepat: 'Sampah Organik', 'Sampah Anorganik', 'Sampah B3', atau 'Sampah Residu'.
Berikan poin antara 10 sampai 30 serta panduan pembersihan/pengolahan langkah demi langkah yang spesifik.

WAJIB berikan output dalam format JSON murni (tanpa teks penjelasan lain) dengan struktur persis seperti ini:
{
  "kategori": "Sampah Anorganik - Botol Plastik Air Mineral",
  "poin": 20,
  "deskripsi": "1. Kosongkan sisa cairan di dalam botol.\\n2. Lepaskan label dan tutup botol.\\n3. Setorkan ke bank sampah terdekat."
}`
          }
        ]
      });

      const rawText = response.text ? response.text.trim() : "";
      
      // Ekstraksi aman menggunakan Regex untuk mengambil blok JSON di dalam respons teks
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        aiResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("Struktur JSON tidak ditemukan dalam respons AI.");
      }

      if (!aiResult.kategori || !aiResult.poin || !aiResult.deskripsi) {
        throw new Error("Properti JSON tidak lengkap.");
      }

    } catch (aiErr) {
      console.warn("Peringatan AI Scan:", aiErr.message);
      aiResult = {
        kategori: "Sampah Anorganik - Barang / Kemasan Umum",
        poin: 20,
        deskripsi: "1. Bersihkan sisa kotoran atau cairan pada objek.\\n2. Pisahkan material yang dapat didaur ulang.\\n3. Salurkan ke fasilitas pengelolaan sampah terdekat."
      };
    }

    const finalPoin = Number(aiResult.poin) || 20;
    const finalKategori = aiResult.kategori || "Sampah Anorganik - Umum";
    const finalDeskripsi = aiResult.deskripsi || "1. Bersihkan objek.\\n2. Kelola sesuai jenisnya.";

    // Perbarui poin user di database SQLite
    db.run('UPDATE users SET total_poin = total_poin + ? WHERE id = ?', [finalPoin, userId], (err) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Gagal memperbarui poin ke database.' });
      }

      res.json({
        success: true,
        kategori: finalKategori,
        poin: finalPoin,
        deskripsi: finalDeskripsi,
        image_url: `/uploads/${req.file.filename}`
      });
    });

  } catch (error) {
    console.error('Error Server Scan:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem di server backend.' });
  }
});

// 4. Endpoint Tambah Poin Kuis
app.post('/api/add-quiz-points', (req, res) => {
  const { user_id, poin } = req.body;
  db.run('UPDATE users SET total_poin = total_poin + ? WHERE id = ?', [poin, user_id], (err) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true });
  });
});

// 5. Endpoint Update Profil
app.post('/api/update-profile', (req, res) => {
  const { user_id, nama, kelas } = req.body;
  db.run('UPDATE users SET nama = ?, kelas = ? WHERE id = ?', [nama, kelas, user_id], (err) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true });
  });
});

app.listen(PORT, () => console.log(`Server Sortify AI berjalan di http://localhost:3000`));