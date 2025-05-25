// server.js
// REST API for PYQ & Notes uploads
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const pdf = require('pdf-parse');
const { promisify } = require('util');
const readFileAsync = promisify(fs.readFile);

const app = express();
const HOST = '127.0.0.1';
const PORT = 5500;

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Function to analyze PDF content
async function analyzePDFContent(filePath) {
    try {
        const dataBuffer = await readFileAsync(filePath);
        const data = await pdf(dataBuffer);
        
        // Convert text to lowercase for case-insensitive matching
        const text = data.text.toLowerCase();
        
        // List of sensitive patterns to check for
        const sensitivePatterns = [
            'password', 'credit card', 'ssn', 'social security',
            'bank account', 'aadhar', 'pan card', 'driving license',
            'passport', 'phone number', 'address', 'email',
            'signature', 'sign', 'stamp', 'seal', 'logo',
            'confidential', 'private', 'secret'
        ];
        
        // Check for sensitive information
        const foundPatterns = sensitivePatterns.filter(pattern => 
            text.includes(pattern.toLowerCase())
        );
        
        // Check for image content
        const hasImages = data.numpages > 0 && data.info.Images > 0;
        
        return {
            isSafe: foundPatterns.length === 0 && !hasImages,
            issues: {
                sensitiveInfo: foundPatterns,
                hasImages: hasImages
            }
        };
    } catch (error) {
        console.error('Error analyzing PDF:', error);
        return {
            isSafe: false,
            issues: {
                error: 'Failed to analyze PDF content'
            }
        };
    }
}

// Configure multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = 'uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: function (req, file, cb) {
        if (file.mimetype !== 'application/pdf') {
            return cb(new Error('Only PDF files are allowed'));
        }
        cb(null, true);
    }
});

// SQLite setup
const db = new sqlite3.Database("uploads.db");
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    branch TEXT,
    sem TEXT,
    subject TEXT,
    fileName TEXT,
    filePath TEXT,
    uploaderEmail TEXT,
    uploaderName TEXT,
    uploaderRole TEXT,
    uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Get all uploads
app.get("/api/uploads", (req, res) => {
  db.all("SELECT * FROM uploads ORDER BY uploadedAt DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Upload a file
app.post("/api/uploads", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Analyze the uploaded file
    const analysis = await analyzePDFContent(req.file.path);
    
    if (!analysis.isSafe) {
      // Delete the file if it doesn't pass analysis
      fs.unlinkSync(req.file.path);
      
      let errorMessage = "File rejected due to: ";
      if (analysis.issues.sensitiveInfo && analysis.issues.sensitiveInfo.length > 0) {
        errorMessage += `Contains sensitive information (${analysis.issues.sensitiveInfo.join(', ')}). `;
      }
      if (analysis.issues.hasImages) {
        errorMessage += "Contains images. ";
      }
      if (analysis.issues.error) {
        errorMessage += analysis.issues.error;
      }
      
      return res.status(400).json({ error: errorMessage });
    }

    // If file passes analysis, proceed with saving to database
    const { type, branch, sem, subject, uploader_email, uploader_name, uploader_role } = req.body;
    
    const stmt = db.prepare(`
      INSERT INTO uploads (type, branch, sem, subject, fileName, filePath, uploaderEmail, uploaderName, uploaderRole)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      type,
      branch,
      sem,
      subject,
      req.file.originalname,
      req.file.filename,
      uploader_email,
      uploader_name,
      uploader_role
    );
    
    res.json({ message: "File uploaded successfully" });
  } catch (error) {
    console.error("Upload error:", error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: "Upload failed" });
  }
});

// Delete an upload
app.delete("/api/uploads/:id", (req, res) => {
  const id = req.params.id;
  db.get("SELECT filePath FROM uploads WHERE id = ?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Upload not found" });
    
    // Delete file from filesystem
    const filePath = path.join(UPLOADS_DIR, row.filePath);
    fs.unlink(filePath, (err) => {
      if (err) console.error("Error deleting file:", err);
      
      // Delete from database
      db.run("DELETE FROM uploads WHERE id = ?", [id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Upload deleted" });
      });
    });
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
