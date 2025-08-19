const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const app = express();

// Security middleware
app.use(helmet());

// Compression middleware for better response times
app.use(compression());

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// CORS configuration with more restrictive settings
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Environment-based configuration
const SECRET_KEY = process.env.JWT_SECRET || "uma_chave_super_secreta";
const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS) || 10;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';

// Database connection pool with optimized settings
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
  maxUses: 7500, // Close (and replace) a connection after it has been used 7500 times
});

// Connection pool error handling
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Pre-hashed password for better performance (avoid re-hashing on every login)
const user = {
  username: process.env.ADMIN_USERNAME || "admin",
  passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || "senha123", SALT_ROUNDS)
};

// Database initialization with better error handling
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Create table with better indexing
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS atendimentos (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        start TIMESTAMP NOT NULL,
        "end" TIMESTAMP,
        recurrence_id UUID,
        paid BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    
    await client.query(createTableQuery);
    
    // Create indexes for better query performance
    const createIndexesQuery = `
      CREATE INDEX IF NOT EXISTS idx_atendimentos_start ON atendimentos(start);
      CREATE INDEX IF NOT EXISTS idx_atendimentos_recurrence_id ON atendimentos(recurrence_id);
      CREATE INDEX IF NOT EXISTS idx_atendimentos_paid ON atendimentos(paid);
      CREATE INDEX IF NOT EXISTS idx_atendimentos_start_paid ON atendimentos(start, paid);
    `;
    
    await client.query(createIndexesQuery);
    
    await client.query('COMMIT');
    console.log("Database initialized successfully with optimized indexes!");
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Error initializing database:", err);
    throw err;
  } finally {
    client.release();
  }
}

// Initialize database
initDB().catch(console.error);

// Optimized login route with better error handling
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }
    
    if (username === user.username && bcrypt.compareSync(password, user.passwordHash)) {
      const token = jwt.sign({ username, iat: Date.now() }, SECRET_KEY, { 
        expiresIn: JWT_EXPIRES_IN,
        algorithm: 'HS256'
      });
      res.json({ token });
    } else {
      res.status(401).json({ message: 'Invalid username or password' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Database health check with connection pooling
app.get('/wake-up', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    res.json({ 
      status: 'awake', 
      time: new Date(),
      poolSize: pool.totalCount,
      idleCount: pool.idleCount
    });
  } catch (error) {
    console.error('Database health check failed:', error);
    res.status(500).json({ error: 'Database not responding' });
  } finally {
    client.release();
  }
});

// Optimized JWT verification middleware
function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ message: 'Token not provided' });
    }

    jwt.verify(token, SECRET_KEY, { algorithms: ['HS256'] }, (err, decoded) => {
      if (err) {
        if (err.name === 'TokenExpiredError') {
          return res.status(401).json({ message: 'Token expired' });
        }
        return res.status(403).json({ message: 'Invalid token' });
      }
      req.user = decoded;
      next();
    });
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

// Optimized route for listing atendimentos with pagination and filtering
app.get("/atendimentos", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { page = 1, limit = 50, start_date, end_date, paid } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = '';
    let queryParams = [];
    let paramCount = 0;
    
    if (start_date) {
      paramCount++;
      whereClause += ` WHERE start >= $${paramCount}`;
      queryParams.push(start_date);
    }
    
    if (end_date) {
      paramCount++;
      whereClause += whereClause ? ` AND start <= $${paramCount}` : ` WHERE start <= $${paramCount}`;
      queryParams.push(end_date);
    }
    
    if (paid !== undefined) {
      paramCount++;
      whereClause += whereClause ? ` AND paid = $${paramCount}` : ` WHERE paid = $${paramCount}`;
      queryParams.push(paid === 'true');
    }
    
    // Count total records for pagination
    const countQuery = `SELECT COUNT(*) FROM atendimentos${whereClause}`;
    const countResult = await client.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count);
    
    // Get paginated results
    paramCount++;
    const dataQuery = `
      SELECT * FROM atendimentos 
      ${whereClause}
      ORDER BY start DESC 
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;
    queryParams.push(limit, offset);
    
    const result = await client.query(dataQuery, queryParams);
    
    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("Error fetching atendimentos:", err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Optimized route for creating atendimentos with batch operations
app.post("/atendimentos", authenticateToken, async (req, res) => {
  const { title, start, end, repeat, times, paid = false } = req.body;

  if (!title || !start) {
    return res.status(400).json({ error: "Title and start fields are required" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    if (repeat && times > 1) {
      // Batch insert for recurring events
      const recurrenceId = uuidv4();
      const startDate = new Date(start);
      const endDate = end ? new Date(end) : null;
      const diffMs = endDate ? (endDate - startDate) : 0;
      
      const values = [];
      const placeholders = [];
      let paramCount = 0;
      
      for (let i = 0; i < times; i++) {
        const s = new Date(startDate);
        const e = endDate ? new Date(s.getTime() + diffMs) : null;
        
        values.push(title, s.toISOString(), e ? e.toISOString() : null, recurrenceId, paid);
        placeholders.push(`($${++paramCount}, $${++paramCount}, $${++paramCount}, $${++paramCount}, $${++paramCount})`);
        
        if (repeat === "weekly") {
          startDate.setDate(startDate.getDate() + 7);
          if (endDate) endDate.setDate(endDate.getDate() + 7);
        } else if (repeat === "daily") {
          startDate.setDate(startDate.getDate() + 1);
          if (endDate) endDate.setDate(endDate.getDate() + 1);
        }
      }
      
      const batchQuery = `
        INSERT INTO atendimentos (title, start, "end", recurrence_id, paid) 
        VALUES ${placeholders.join(', ')}
      `;
      
      await client.query(batchQuery, values);
      await client.query('COMMIT');
      
      res.json({ 
        status: "ok", 
        message: `Created ${times} recurring events`, 
        recurrenceId 
      });
    } else {
      // Single event
      const result = await client.query(
        `INSERT INTO atendimentos (title, start, "end", paid) VALUES ($1, $2, $3, $4) RETURNING id`,
        [title, start, end, paid]
      );
      
      await client.query('COMMIT');
      res.json({ 
        id: result.rows[0].id, 
        message: "Event created successfully" 
      });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Error creating atendimento:", err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Optimized update route
app.put("/atendimentos/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { title, start, end, paid = false } = req.body;

  if (!title || !start) {
    return res.status(400).json({ error: "Title and start fields are required" });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE atendimentos 
       SET title = $1, start = $2, "end" = $3, paid = $4, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $5 RETURNING id`,
      [title, start, end, paid, id]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Event not found" });
    }
    
    res.json({ 
      updated: result.rowCount, 
      message: "Event updated successfully" 
    });
  } catch (err) {
    console.error("Error updating atendimento:", err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Optimized delete route
app.delete("/atendimentos/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `DELETE FROM atendimentos WHERE id = $1 RETURNING id`,
      [id]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Event not found" });
    }
    
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error("Error deleting atendimento:", err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Optimized recurrence deletion route
app.delete("/atendimentos/recurrence/:recurrenceId/from/:id", authenticateToken, async (req, res) => {
  const { recurrenceId, id } = req.params;
  const client = await pool.connect();
  
  try {
    const event = await client.query(
      `SELECT start FROM atendimentos WHERE id = $1`,
      [id]
    );
    
    if (event.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" });
    }

    const startDate = event.rows[0].start.toISOString();
    const result = await client.query(
      `DELETE FROM atendimentos WHERE recurrence_id = $1 AND start >= $2`,
      [recurrenceId, startDate]
    );

    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error("Error deleting recurrence series:", err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Optimized statistics route with caching considerations
app.get("/estatisticas", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN paid THEN 1 ELSE 0 END) as pagas,
        SUM(CASE WHEN NOT paid THEN 1 ELSE 0 END) as nao_pagas,
        COUNT(DISTINCT DATE(start)) as dias_com_atendimento,
        AVG(EXTRACT(EPOCH FROM ("end" - start))/3600) as duracao_media_horas
      FROM atendimentos
      WHERE start >= NOW() - INTERVAL '30 days'
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching statistics:", err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  pool.end();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  pool.end();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Optimized backend running on port ${PORT}`);
  console.log(`Login: ${user.username} / ${process.env.ADMIN_PASSWORD || 'senha123'}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});