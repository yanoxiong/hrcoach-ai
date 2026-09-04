require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const OpenAI = require("openai");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const DB_PATH = path.resolve(process.env.DATABASE_PATH || "./data/hrcoach.db");
const DEMO_MODE = String(process.env.DEMO_MODE || "true").toLowerCase() === "true";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'manager',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  position TEXT DEFAULT '',
  department TEXT DEFAULT '',
  start_date TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id INTEGER,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  category TEXT DEFAULT '',
  input_text TEXT DEFAULT '',
  output_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id);
CREATE INDEX IF NOT EXISTS idx_records_company ON records(company_id);
`);

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
    { sub: user.id, company_id: user.company_id, role: user.role, email: user.email },
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

function employeeBelongsToCompany(employeeId, companyId) {
  if (!employeeId) return true;
  return !!db.prepare("SELECT id FROM employees WHERE id = ? AND company_id = ?").get(employeeId, companyId);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, demoMode: DEMO_MODE, model: MODEL });
});

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, companyName } = req.body || {};
  if (!name || !email || !password || !companyName) {
    return res.status(400).json({ error: "Name, email, password, and company name are required." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(String(email).trim());
  if (exists) return res.status(409).json({ error: "An account with that email already exists." });

  const tx = db.transaction(() => {
    const company = db.prepare("INSERT INTO companies (name) VALUES (?)").run(String(companyName).trim());
    const passwordHash = bcrypt.hashSync(String(password), 12);
    const user = db.prepare(`
      INSERT INTO users (company_id, name, email, password_hash, role)
      VALUES (?, ?, ?, ?, 'admin')
    `).run(company.lastInsertRowid, String(name).trim(), String(email).trim().toLowerCase(), passwordHash);

    const demoEmployees = [
      ["Sarah Johnson", "Front End Supervisor", "Front End", "2024-01-15"],
      ["Mark Davis", "Grocery Clerk", "Grocery", "2025-03-02"],
      ["John Lee", "Produce Lead", "Produce", "2023-07-11"]
    ];
    const insertEmployee = db.prepare(`
      INSERT INTO employees (company_id, name, position, department, start_date)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const e of demoEmployees) insertEmployee.run(company.lastInsertRowid, ...e);

    return db.prepare("SELECT id, company_id, name, email, role FROM users WHERE id = ?").get(user.lastInsertRowid);
  });

  try {
    const user = tx();
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  const safe = { id: user.id, company_id: user.company_id, name: user.name, email: user.email, role: user.role };
  res.json({ token: signToken(safe), user: safe });
});

app.get("/api/me", auth, (req, res) => {
  const user = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, c.id AS company_id, c.name AS company_name
    FROM users u JOIN companies c ON c.id = u.company_id
    WHERE u.id = ? AND u.company_id = ?
  `).get(req.user.sub, req.user.company_id);
  res.json(user);
});

app.get("/api/employees", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, position, department, start_date, created_at
    FROM employees WHERE company_id = ? ORDER BY name
  `).all(req.user.company_id);
  res.json(rows);
});

app.post("/api/employees", auth, (req, res) => {
  const { name, position = "", department = "", startDate = "" } = req.body || {};
  if (!name) return res.status(400).json({ error: "Employee name is required." });
  const result = db.prepare(`
    INSERT INTO employees (company_id, name, position, department, start_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.company_id, String(name).trim(), String(position).trim(), String(department).trim(), String(startDate).trim());
  const row = db.prepare("SELECT * FROM employees WHERE id = ? AND company_id = ?").get(result.lastInsertRowid, req.user.company_id);
  res.status(201).json(row);
});

app.delete("/api/employees/:id", auth, (req, res) => {
  const result = db.prepare("DELETE FROM employees WHERE id = ? AND company_id = ?").run(req.params.id, req.user.company_id);
  if (!result.changes) return res.status(404).json({ error: "Employee not found." });
  res.json({ ok: true });
});

app.get("/api/records", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.type, r.category, r.input_text, r.output_text, r.created_at,
           e.name AS employee_name
    FROM records r
    LEFT JOIN employees e ON e.id = r.employee_id
    WHERE r.company_id = ?
    ORDER BY r.id DESC
    LIMIT 200
  `).all(req.user.company_id);
  res.json(rows);
});

app.post("/api/records", auth, (req, res) => {
  const { employeeId = null, type, category = "", inputText = "", outputText } = req.body || {};
  if (!type || !outputText) return res.status(400).json({ error: "Type and output are required." });
  if (!employeeBelongsToCompany(employeeId, req.user.company_id)) {
    return res.status(403).json({ error: "Invalid employee." });
  }
  const result = db.prepare(`
    INSERT INTO records (company_id, employee_id, user_id, type, category, input_text, output_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.company_id, employeeId || null, req.user.sub, type, category, inputText, outputText);
  res.status(201).json({ id: result.lastInsertRowid });
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
  const { tool = "ask", employeeId = null, category = "", situation = "" } = req.body || {};
  if (!String(situation).trim()) return res.status(400).json({ error: "Situation details are required." });
  if (!["ask", "documentation", "conversation", "recognition"].includes(tool)) {
    return res.status(400).json({ error: "Unknown tool." });
  }
  if (!employeeBelongsToCompany(employeeId, req.user.company_id)) {
    return res.status(403).json({ error: "Invalid employee." });
  }

  const employee = employeeId
    ? db.prepare("SELECT name, position, department FROM employees WHERE id = ? AND company_id = ?").get(employeeId, req.user.company_id)
    : null;

  const employeeName = employee?.name || "Employee";

  if (DEMO_MODE || !process.env.OPENAI_API_KEY) {
    return res.json({
      text: demoResponse(tool, employeeName, category, String(situation).trim()),
      mode: "demo"
    });
  }

  try {
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

app.delete("/api/account", auth, (req, res) => {
  // MVP behavior: delete the entire company only when the signed-in user is admin.
  if (req.user.role !== "admin") return res.status(403).json({ error: "Only an admin can delete the company account." });
  db.prepare("DELETE FROM companies WHERE id = ?").run(req.user.company_id);
  res.json({ ok: true });
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found." });
  }

  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`HRCoach AI running at http://localhost:${PORT}`);
  console.log(`Demo mode: ${DEMO_MODE ? "ON" : "OFF"}`);
});
