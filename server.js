require("dotenv").config();

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const DEMO_MODE = String(process.env.DEMO_MODE || "true").toLowerCase() === "true";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const isRenderInternal = DATABASE_URL.includes(".internal");
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isRenderInternal ? false : { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'manager',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS employees (
      id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position TEXT DEFAULT '',
      department TEXT DEFAULT '',
      start_date TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS records (
      id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      employee_id BIGINT REFERENCES employees(id) ON DELETE SET NULL,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      category TEXT DEFAULT '',
      input_text TEXT DEFAULT '',
      output_text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id);
    CREATE INDEX IF NOT EXISTS idx_records_company ON records(company_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));
  `);
}

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use(express.static(path.join(__dirname, "public")));

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), company_id: String(user.company_id), role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Sign in again." });
  }
}

async function employeeBelongsToCompany(employeeId, companyId) {
  if (!employeeId) return true;
  const { rowCount } = await pool.query(
    "SELECT 1 FROM employees WHERE id = $1 AND company_id = $2",
    [employeeId, companyId]
  );
  return rowCount > 0;
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, demoMode: DEMO_MODE, model: MODEL, database: "postgres" });
  } catch {
    res.status(503).json({ ok: false, error: "Database unavailable." });
  }
});

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, companyName } = req.body || {};
  if (!name || !email || !password || !companyName) {
    return res.status(400).json({ error: "Name, email, password, and company name are required." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const client = await pool.connect();
  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const exists = await client.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [normalizedEmail]);
    if (exists.rowCount) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    await client.query("BEGIN");

    const companyResult = await client.query(
      "INSERT INTO companies (name) VALUES ($1) RETURNING id",
      [String(companyName).trim()]
    );
    const companyId = companyResult.rows[0].id;

    const passwordHash = bcrypt.hashSync(String(password), 12);
    const userResult = await client.query(`
      INSERT INTO users (company_id, name, email, password_hash, role)
      VALUES ($1, $2, $3, $4, 'admin')
      RETURNING id, company_id, name, email, role
    `, [companyId, String(name).trim(), normalizedEmail, passwordHash]);

    const demoEmployees = [
      ["Sarah Johnson", "Front End Supervisor", "Front End", "2024-01-15"],
      ["Mark Davis", "Grocery Clerk", "Grocery", "2025-03-02"],
      ["John Lee", "Produce Lead", "Produce", "2023-07-11"]
    ];
    for (const e of demoEmployees) {
      await client.query(`
        INSERT INTO employees (company_id, name, position, department, start_date)
        VALUES ($1, $2, $3, $4, $5)
      `, [companyId, ...e]);
    }

    await client.query("COMMIT");
    const user = userResult.rows[0];
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error(err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    res.status(500).json({ error: "Could not create account." });
  } finally {
    client.release();
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1)",
      [String(email || "").trim()]
    );
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const safe = { id: user.id, company_id: user.company_id, name: user.name, email: user.email, role: user.role };
    res.json({ token: signToken(safe), user: safe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not sign in." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.role, c.id AS company_id, c.name AS company_name
      FROM users u JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1 AND u.company_id = $2
    `, [req.user.sub, req.user.company_id]);
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load account." });
  }
});

app.get("/api/employees", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, position, department, start_date, created_at
      FROM employees WHERE company_id = $1 ORDER BY name
    `, [req.user.company_id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load employees." });
  }
});

app.post("/api/employees", auth, async (req, res) => {
  try {
    const { name, position = "", department = "", startDate = "" } = req.body || {};
    if (!name) return res.status(400).json({ error: "Employee name is required." });
    const result = await pool.query(`
      INSERT INTO employees (company_id, name, position, department, start_date)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [req.user.company_id, String(name).trim(), String(position).trim(), String(department).trim(), String(startDate).trim()]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not add employee." });
  }
});

app.delete("/api/employees/:id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM employees WHERE id = $1 AND company_id = $2",
      [req.params.id, req.user.company_id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Employee not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete employee." });
  }
});

app.get("/api/records", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.id, r.type, r.category, r.input_text, r.output_text, r.created_at,
             e.name AS employee_name
      FROM records r
      LEFT JOIN employees e ON e.id = r.employee_id
      WHERE r.company_id = $1
      ORDER BY r.id DESC
      LIMIT 200
    `, [req.user.company_id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load records." });
  }
});

app.post("/api/records", auth, async (req, res) => {
  try {
    const { employeeId = null, type, category = "", inputText = "", outputText } = req.body || {};
    if (!type || !outputText) return res.status(400).json({ error: "Type and output are required." });
    if (!(await employeeBelongsToCompany(employeeId, req.user.company_id))) {
      return res.status(403).json({ error: "Invalid employee." });
    }
    const result = await pool.query(`
      INSERT INTO records (company_id, employee_id, user_id, type, category, input_text, output_text)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [req.user.company_id, employeeId || null, req.user.sub, type, category, inputText, outputText]);
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save record." });
  }
});

function demoResponse(tool, employeeName, category, situation) {
  if (tool === "recognition") {
    return `${category || "Recognition"} Recognition

${employeeName || "The employee"} demonstrated strong ${String(category || "teamwork").toLowerCase()} through the behavior described: ${situation}

Their contribution had a positive impact on the team and is worth recognizing. Thank you for the effort and professionalism shown.`;
  }
  if (tool === "documentation") {
    return `Employee: ${employeeName || "[Employee]"}
Issue: ${category || "Workplace concern"}

Manager observations:
${situation}

Employee response:
[Record the employee's response in their own words.]

Expected improvement:
Clearly restate the applicable workplace expectation and any agreed next steps.

Follow-up:
[Enter a reasonable follow-up date or checkpoint.]

Review this draft for factual accuracy and against company policy before use.`;
  }
  if (tool === "conversation") {
    return `Conversation plan — ${category || "Workplace concern"}

Opening:
“I’d like to talk about a workplace concern and hear your perspective.”

Describe the observed behavior:
${situation}

Ask for perspective:
“Can you help me understand what happened from your point of view?”

Clarify expectations:
State the relevant expectation clearly and neutrally.

Close:
Confirm next steps, support available, and the follow-up point.

For serious, protected, or legally sensitive matters, involve HR or qualified counsel.`;
  }
  return `Suggested management approach

1. Confirm the specific facts and relevant company policy.
2. Address the situation privately and use observable behavior rather than assumptions.
3. Ask for the employee's perspective.
4. Clarify the workplace expectation and what needs to happen next.
5. Document the conversation factually.
6. Set a follow-up point.

Possible opener:
“I want to discuss a workplace concern, understand your perspective, and make sure expectations are clear going forward.”

This is general management support, not legal advice or an automated employment decision.`;
}

function systemPrompt(tool) {
  const common = `You are HRCoach AI, a management-support assistant for frontline managers.
You provide practical, respectful, neutral workplace coaching.
Never invent facts. Never infer protected characteristics. Never tell the manager to fire, hire, promote, demote, punish, or otherwise make a final employment decision.
Do not claim to provide legal advice.
Use observable behavior, employee perspective, company policy review, clear expectations, and appropriate follow-up.
For serious safety, harassment, discrimination, retaliation, accommodation, leave, wage/hour, union, violence, medical, or other legally sensitive matters, recommend involving the organization's HR professional or qualified counsel.
Keep outputs concise and useful.`;

  const specific = {
    ask: "Give a structured suggested approach, a possible conversation opener, and 3-6 practical next steps.",
    documentation: "Turn the manager's notes into an objective documentation draft. Separate observations, employee response placeholder, expectations, and follow-up. Do not embellish.",
    conversation: "Create a respectful conversation plan with opening, observed behavior, questions for the employee, expectations, and close.",
    recognition: "Write a short positive recognition message emphasizing behavior and impact without inventing accomplishments."
  }[tool] || "Give practical management guidance.";

  return `${common}\n\nTask: ${specific}`;
}

app.post("/api/ai/generate", auth, async (req, res) => {
  try {
    const { tool = "ask", employeeId = null, category = "", situation = "" } = req.body || {};
    if (!String(situation).trim()) return res.status(400).json({ error: "Situation details are required." });
    if (!["ask", "documentation", "conversation", "recognition"].includes(tool)) {
      return res.status(400).json({ error: "Unknown tool." });
    }
    if (!(await employeeBelongsToCompany(employeeId, req.user.company_id))) {
      return res.status(403).json({ error: "Invalid employee." });
    }

    let employee = null;
    if (employeeId) {
      const result = await pool.query(
        "SELECT name, position, department FROM employees WHERE id = $1 AND company_id = $2",
        [employeeId, req.user.company_id]
      );
      employee = result.rows[0] || null;
    }

    const employeeName = employee?.name || "Employee";

    if (DEMO_MODE || !process.env.OPENAI_API_KEY) {
      return res.json({
        text: demoResponse(tool, employeeName, category, String(situation).trim()),
        mode: "demo"
      });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const userContext = [
      `Employee name: ${employeeName}`,
      employee?.position ? `Position: ${employee.position}` : "",
      employee?.department ? `Department: ${employee.department}` : "",
      category ? `Category: ${category}` : "",
      `Manager notes: ${String(situation).trim()}`
    ].filter(Boolean).join("\n");

    const response = await client.responses.create({
      model: MODEL,
      instructions: systemPrompt(tool),
      input: userContext
    });

    const text = response.output_text?.trim();
    if (!text) throw new Error("No text returned from model.");
    res.json({ text, mode: "live" });
  } catch (err) {
    console.error("AI error:", err);
    res.status(502).json({ error: "AI service could not generate a response. Try again." });
  }
});

app.delete("/api/account", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only an admin can delete the company account." });
    }
    await pool.query("DELETE FROM companies WHERE id = $1", [req.user.company_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete company account." });
  }
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found." });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`HRCoach AI running at http://localhost:${PORT}`);
      console.log(`Demo mode: ${DEMO_MODE ? "ON" : "OFF"}`);
      console.log("Database: PostgreSQL");
    });
  })
  .catch((err) => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });