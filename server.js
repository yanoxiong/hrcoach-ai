require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { Resend } = require("resend");
const { Pool } = require("pg");
const OpenAI = require("openai");
const Stripe = require("stripe");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const DEMO_MODE = String(process.env.DEMO_MODE || "true").toLowerCase() === "true";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const DATABASE_URL = process.env.DATABASE_URL;
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const EMAIL_MODE = String(process.env.EMAIL_MODE || "console").toLowerCase();
const REQUIRE_EMAIL_VERIFICATION =
  String(process.env.REQUIRE_EMAIL_VERIFICATION || "true").toLowerCase() === "true";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_FOUNDING = process.env.STRIPE_PRICE_FOUNDING || "";
const STRIPE_PRICE_BUSINESS = process.env.STRIPE_PRICE_BUSINESS || "";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes(".internal") ? false : { rejectUnauthorized: false }
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
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

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

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id);
    CREATE INDEX IF NOT EXISTS idx_records_company ON records(company_id);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_plan TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;
  `);
}

app.set("trust proxy", 1);
app.use(helmet());
app.post("/api/stripe/webhook", express.raw({type:"application/json"}), async (req,res)=>{
  if(!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send("Stripe is not configured.");
  let event;
  try { event=stripe.webhooks.constructEvent(req.body,req.headers["stripe-signature"],STRIPE_WEBHOOK_SECRET); }
  catch(e){ console.error("Stripe webhook signature error:",e.message); return res.status(400).send("Invalid signature."); }
  try {
    const obj=event.data.object;
    if(event.type==="checkout.session.completed" && obj.mode==="subscription" && obj.metadata?.company_id)
      await pool.query(`UPDATE companies SET stripe_customer_id=$1,stripe_subscription_id=$2 WHERE id=$3`,[obj.customer,obj.subscription,obj.metadata.company_id]);
    if(["customer.subscription.created","customer.subscription.updated","customer.subscription.deleted"].includes(event.type)){
      const companyId=obj.metadata?.company_id, plan=obj.metadata?.plan||null;
      const trialEnd=obj.trial_end?new Date(obj.trial_end*1000):null, periodEnd=obj.current_period_end?new Date(obj.current_period_end*1000):null;
      if(companyId) await pool.query(`UPDATE companies SET stripe_customer_id=$1,stripe_subscription_id=$2,subscription_status=$3,subscription_plan=COALESCE($4,subscription_plan),trial_ends_at=$5,subscription_current_period_end=$6 WHERE id=$7`,[obj.customer,obj.id,obj.status,plan,trialEnd,periodEnd,companyId]);
      else await pool.query(`UPDATE companies SET subscription_status=$1,trial_ends_at=$2,subscription_current_period_end=$3 WHERE stripe_subscription_id=$4`,[obj.status,trialEnd,periodEnd,obj.id]);
    }
    if(event.type==="invoice.payment_failed"){ const sid=typeof obj.subscription==="string"?obj.subscription:obj.subscription?.id; if(sid) await pool.query(`UPDATE companies SET subscription_status='past_due' WHERE stripe_subscription_id=$1`,[sid]); }
    res.json({received:true});
  }catch(e){console.error("Stripe webhook handler error:",e);res.status(500).send("Webhook handler failed.");}
});
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));

const authLimiter = rateLimit({
  windowMs: 15*60*1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." }
});

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), company_id: String(user.company_id), role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Sign in again." });
  }
}

function tokenRaw() { return crypto.randomBytes(32).toString("hex"); }
function tokenHash(raw) { return crypto.createHash("sha256").update(raw).digest("hex"); }

async function createToken(userId, purpose, minutes) {
  await pool.query(
    "UPDATE auth_tokens SET used_at = NOW() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL",
    [userId, purpose]
  );
  const raw = tokenRaw();
  await pool.query(
    `INSERT INTO auth_tokens(user_id,purpose,token_hash,expires_at)
     VALUES($1,$2,$3,NOW()+($4 || ' minutes')::interval)`,
    [userId, purpose, tokenHash(raw), String(minutes)]
  );
  return raw;
}

function transporter() {
  if (EMAIL_MODE !== "smtp") return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendMail(to, subject, text) {
  if (EMAIL_MODE === "console") {
    console.log("\n===== HRCOACH EMAIL (CONSOLE MODE) =====");
    console.log("To:", to);
    console.log("Subject:", subject);
    console.log(text);
    console.log("===== END EMAIL =====\n");
    return;
  }

  if (EMAIL_MODE === "resend") {
    if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");
    if (!process.env.EMAIL_FROM) throw new Error("EMAIL_FROM is not configured.");

    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject,
      text
    });

    if (error) throw new Error(error.message || "Resend could not send email.");
    console.log("Resend email sent:", data?.id || "ok");
    return;
  }

  const t = transporter();
  if (!t) throw new Error("Email transport not configured.");
  await t.sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to, subject, text });
}

async function sendVerification(user) {
  const raw = await createToken(user.id, "verify_email", 1440);
  const link = `${APP_BASE_URL}/?verify=${encodeURIComponent(raw)}`;
  await sendMail(user.email, "Verify your HRCoach AI email",
`Welcome to HRCoach AI.

Verify your email:
${link}

This link expires in 24 hours.`);
}

async function sendReset(user) {
  const raw = await createToken(user.id, "reset_password", 30);
  const link = `${APP_BASE_URL}/?reset=${encodeURIComponent(raw)}`;
  await sendMail(user.email, "Reset your HRCoach AI password",
`Reset your HRCoach AI password:
${link}

This link expires in 30 minutes.`);
}

async function employeeBelongs(employeeId, companyId) {
  if (!employeeId) return true;
  const r = await pool.query("SELECT 1 FROM employees WHERE id=$1 AND company_id=$2",[employeeId,companyId]);
  return r.rowCount > 0;
}

app.get("/api/health", async (req,res)=>{
  try {
    await pool.query("SELECT 1");
    res.json({ok:true,demoMode:DEMO_MODE,model:MODEL,database:"postgres",emailMode:EMAIL_MODE,emailVerificationRequired:REQUIRE_EMAIL_VERIFICATION});
  } catch {
    res.status(503).json({ok:false,error:"Database unavailable."});
  }
});

app.post("/api/auth/register", authLimiter, async (req,res)=>{
  const {name,email,password,companyName} = req.body || {};
  if(!name||!email||!password||!companyName) return res.status(400).json({error:"Name, email, password, and company name are required."});
  if(String(password).length<8) return res.status(400).json({error:"Password must be at least 8 characters."});

  const client = await pool.connect();
  try {
    const normalized = String(email).trim().toLowerCase();
    const exists = await client.query("SELECT id FROM users WHERE LOWER(email)=LOWER($1)",[normalized]);
    if(exists.rowCount) return res.status(409).json({error:"An account with that email already exists."});

    await client.query("BEGIN");
    const c = await client.query("INSERT INTO companies(name) VALUES($1) RETURNING id",[String(companyName).trim()]);
    const companyId = c.rows[0].id;
    const hash = bcrypt.hashSync(String(password),12);
    const u = await client.query(
      `INSERT INTO users(company_id,name,email,password_hash,role,email_verified)
       VALUES($1,$2,$3,$4,'admin',$5)
       RETURNING id,company_id,name,email,role,email_verified`,
      [companyId,String(name).trim(),normalized,hash,REQUIRE_EMAIL_VERIFICATION?false:true]
    );
    const demo = [
      ["Sarah Johnson","Front End Supervisor","Front End","2024-01-15"],
      ["Mark Davis","Grocery Clerk","Grocery","2025-03-02"],
      ["John Lee","Produce Lead","Produce","2023-07-11"]
    ];
    for (const e of demo) {
      await client.query(
        "INSERT INTO employees(company_id,name,position,department,start_date) VALUES($1,$2,$3,$4,$5)",
        [companyId,...e]
      );
    }
    await client.query("COMMIT");
    const user=u.rows[0];

    if(REQUIRE_EMAIL_VERIFICATION){
      try { await sendVerification(user); } catch(e){ console.error("Verification email error:",e); }
      return res.status(201).json({
        verificationRequired:true,
        message: EMAIL_MODE==="console"
          ? "Account created. Open Render logs to get the verification link."
          : "Account created. Check your email to verify your account."
      });
    }
    res.status(201).json({token:signToken(user),user});
  } catch(e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error(e);
    res.status(500).json({error:"Could not create account."});
  } finally { client.release(); }
});

app.post("/api/auth/login", authLimiter, async (req,res)=>{
  try {
    const {email,password}=req.body||{};
    const r=await pool.query("SELECT * FROM users WHERE LOWER(email)=LOWER($1)",[String(email||"").trim()]);
    const user=r.rows[0];
    if(!user||!bcrypt.compareSync(String(password||""),user.password_hash)) return res.status(401).json({error:"Invalid email or password."});
    if(REQUIRE_EMAIL_VERIFICATION && !user.email_verified) return res.status(403).json({error:"Verify your email before signing in.",code:"EMAIL_NOT_VERIFIED"});
    const safe={id:user.id,company_id:user.company_id,name:user.name,email:user.email,role:user.role};
    res.json({token:signToken(safe),user:safe});
  } catch(e){console.error(e);res.status(500).json({error:"Could not sign in."});}
});

app.post("/api/auth/resend-verification", authLimiter, async (req,res)=>{
  try{
    const email=String(req.body?.email||"").trim().toLowerCase();
    const r=await pool.query("SELECT id,email,email_verified FROM users WHERE LOWER(email)=LOWER($1)",[email]);
    const user=r.rows[0];
    if(user&&!user.email_verified){try{await sendVerification(user);}catch(e){console.error(e);}}
    res.json({message:"If an unverified account exists, a new verification link has been sent."});
  }catch(e){console.error(e);res.status(500).json({error:"Could not process request."});}
});

app.post("/api/auth/verify-email", authLimiter, async (req,res)=>{
  try{
    const h=tokenHash(String(req.body?.token||""));
    const r=await pool.query(
      `SELECT id,user_id FROM auth_tokens
       WHERE token_hash=$1 AND purpose='verify_email' AND used_at IS NULL AND expires_at>NOW()`,[h]);
    if(!r.rowCount) return res.status(400).json({error:"Verification link is invalid or expired."});
    const t=r.rows[0];
    await pool.query("BEGIN");
    try{
      await pool.query("UPDATE users SET email_verified=TRUE, verified_at=NOW() WHERE id=$1",[t.user_id]);
      await pool.query("UPDATE auth_tokens SET used_at=NOW() WHERE id=$1",[t.id]);
      await pool.query("COMMIT");
    }catch(e){await pool.query("ROLLBACK");throw e;}
    res.json({ok:true,message:"Email verified. You can now sign in."});
  }catch(e){console.error(e);res.status(500).json({error:"Could not verify email."});}
});

app.post("/api/auth/forgot-password", authLimiter, async (req,res)=>{
  try{
    const email=String(req.body?.email||"").trim().toLowerCase();
    const r=await pool.query("SELECT id,email FROM users WHERE LOWER(email)=LOWER($1)",[email]);
    if(r.rows[0]){try{await sendReset(r.rows[0]);}catch(e){console.error(e);}}
    res.json({message:"If an account exists for that email, a password reset link has been sent."});
  }catch(e){console.error(e);res.status(500).json({error:"Could not process reset request."});}
});

app.post("/api/auth/reset-password", authLimiter, async (req,res)=>{
  try{
    const raw=String(req.body?.token||"");
    const password=String(req.body?.password||"");
    if(password.length<8) return res.status(400).json({error:"Password must be at least 8 characters."});
    const h=tokenHash(raw);
    const r=await pool.query(
      `SELECT id,user_id FROM auth_tokens
       WHERE token_hash=$1 AND purpose='reset_password' AND used_at IS NULL AND expires_at>NOW()`,[h]);
    if(!r.rowCount) return res.status(400).json({error:"Reset link is invalid or expired."});
    const t=r.rows[0];
    const hash=bcrypt.hashSync(password,12);
    await pool.query("BEGIN");
    try{
      await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",[hash,t.user_id]);
      await pool.query("UPDATE auth_tokens SET used_at=NOW() WHERE user_id=$1 AND purpose='reset_password' AND used_at IS NULL",[t.user_id]);
      await pool.query("COMMIT");
    }catch(e){await pool.query("ROLLBACK");throw e;}
    res.json({ok:true,message:"Password updated. You can now sign in."});
  }catch(e){console.error(e);res.status(500).json({error:"Could not reset password."});}
});

app.get("/api/me", auth, async (req,res)=>{
  try{
    const r=await pool.query(
      `SELECT u.id,u.name,u.email,u.role,u.email_verified,c.id AS company_id,c.name AS company_name,
       c.subscription_status,c.subscription_plan,c.trial_ends_at,c.subscription_current_period_end,c.stripe_customer_id
       FROM users u JOIN companies c ON c.id=u.company_id
       WHERE u.id=$1 AND u.company_id=$2`,[req.user.sub,req.user.company_id]);
    res.json(r.rows[0]||null);
  }catch(e){console.error(e);res.status(500).json({error:"Could not load account."});}
});

app.get("/api/billing/plans", auth, (req,res)=>res.json({configured:Boolean(stripe&&STRIPE_PRICE_FOUNDING&&STRIPE_PRICE_BUSINESS),plans:[{id:"founding",name:"Founding Manager",price:"$29.99"},{id:"business",name:"Business",price:"$59.99"}]}));

app.post("/api/billing/checkout", auth, async (req,res)=>{
  try{
    if(!stripe) return res.status(503).json({error:"Stripe is not configured."});
    if(req.user.role!=="admin") return res.status(403).json({error:"Only an admin can manage billing."});
    const plan=String(req.body?.plan||""), priceId=plan==="founding"?STRIPE_PRICE_FOUNDING:plan==="business"?STRIPE_PRICE_BUSINESS:null;
    if(!priceId) return res.status(400).json({error:"Choose a valid plan."});
    const c=(await pool.query(`SELECT stripe_customer_id,subscription_status FROM companies WHERE id=$1`,[req.user.company_id])).rows[0];
    const u=(await pool.query(`SELECT email FROM users WHERE id=$1`,[req.user.sub])).rows[0];
    if(["trialing","active"].includes(c?.subscription_status)) return res.status(409).json({error:"This company already has an active subscription."});
    const session=await stripe.checkout.sessions.create({mode:"subscription",customer:c?.stripe_customer_id||undefined,customer_email:c?.stripe_customer_id?undefined:u?.email,line_items:[{price:priceId,quantity:1}],payment_method_collection:"always",subscription_data:{trial_period_days:14,metadata:{company_id:String(req.user.company_id),plan}},metadata:{company_id:String(req.user.company_id),plan},success_url:`${APP_BASE_URL}/?checkout=success`,cancel_url:`${APP_BASE_URL}/?checkout=cancelled`});
    res.json({url:session.url});
  }catch(e){console.error(e);res.status(500).json({error:"Could not start Stripe Checkout."});}
});

app.post("/api/billing/portal", auth, async (req,res)=>{
  try{
    if(!stripe) return res.status(503).json({error:"Stripe is not configured."});
    const c=(await pool.query(`SELECT stripe_customer_id FROM companies WHERE id=$1`,[req.user.company_id])).rows[0];
    if(!c?.stripe_customer_id) return res.status(400).json({error:"No Stripe customer exists yet."});
    const session=await stripe.billingPortal.sessions.create({customer:c.stripe_customer_id,return_url:`${APP_BASE_URL}/?billing=return`}); res.json({url:session.url});
  }catch(e){console.error(e);res.status(500).json({error:"Could not open billing portal."});}
});

app.get("/api/employees", auth, async (req,res)=>{
  try{
    const r=await pool.query("SELECT id,name,position,department,start_date,created_at FROM employees WHERE company_id=$1 ORDER BY name",[req.user.company_id]);
    res.json(r.rows);
  }catch(e){console.error(e);res.status(500).json({error:"Could not load employees."});}
});

app.post("/api/employees", auth, async (req,res)=>{
  try{
    const {name,position="",department="",startDate=""}=req.body||{};
    if(!name) return res.status(400).json({error:"Employee name is required."});
    const r=await pool.query(
      `INSERT INTO employees(company_id,name,position,department,start_date)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.company_id,String(name).trim(),String(position).trim(),String(department).trim(),String(startDate).trim()]);
    res.status(201).json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:"Could not add employee."});}
});

app.delete("/api/employees/:id", auth, async (req,res)=>{
  try{
    const r=await pool.query("DELETE FROM employees WHERE id=$1 AND company_id=$2",[req.params.id,req.user.company_id]);
    if(!r.rowCount) return res.status(404).json({error:"Employee not found."});
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not delete employee."});}
});

app.get("/api/records", auth, async (req,res)=>{
  try{
    const r=await pool.query(
      `SELECT r.id,r.type,r.category,r.input_text,r.output_text,r.created_at,e.name AS employee_name
       FROM records r LEFT JOIN employees e ON e.id=r.employee_id
       WHERE r.company_id=$1 ORDER BY r.id DESC LIMIT 200`,[req.user.company_id]);
    res.json(r.rows);
  }catch(e){console.error(e);res.status(500).json({error:"Could not load records."});}
});

app.post("/api/records", auth, async (req,res)=>{
  try{
    const {employeeId=null,type,category="",inputText="",outputText}=req.body||{};
    if(!type||!outputText) return res.status(400).json({error:"Type and output are required."});
    if(!(await employeeBelongs(employeeId,req.user.company_id))) return res.status(403).json({error:"Invalid employee."});
    const r=await pool.query(
      `INSERT INTO records(company_id,employee_id,user_id,type,category,input_text,output_text)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.company_id,employeeId||null,req.user.sub,type,category,inputText,outputText]);
    res.status(201).json({id:r.rows[0].id});
  }catch(e){console.error(e);res.status(500).json({error:"Could not save record."});}
});

function systemPrompt(tool) {
  const common = `You are HRCoach AI, a management-support assistant for frontline managers.
Provide practical, respectful, neutral workplace coaching.
Never invent facts or infer protected characteristics.
Never make final employment decisions.
Do not claim to provide legal advice.
For serious safety, harassment, discrimination, retaliation, accommodation, leave, wage/hour, union, violence, medical, or other legally sensitive matters, recommend involving HR or qualified counsel.`;

  const specific = {
    ask:"Give a structured approach, a conversation opener, and practical next steps.",
    documentation:"Turn manager notes into an objective documentation draft. Do not embellish.",
    conversation:"Create a respectful conversation plan with opening, observed behavior, questions, expectations, and close.",
    recognition:"Write a concise recognition message emphasizing behavior and impact."
  }[tool] || "Give practical management guidance.";

  return `${common}\n\nTask: ${specific}`;
}

app.post("/api/ai/generate", auth, async (req,res)=>{
  try{
    const {tool="ask",employeeId=null,category="",situation=""}=req.body||{};
    if(!String(situation).trim()) return res.status(400).json({error:"Situation details are required."});
    if(!["ask","documentation","conversation","recognition"].includes(tool)) return res.status(400).json({error:"Unknown tool."});
    if(!(await employeeBelongs(employeeId,req.user.company_id))) return res.status(403).json({error:"Invalid employee."});

    let employee=null;
    if(employeeId){
      const r=await pool.query("SELECT name,position,department FROM employees WHERE id=$1 AND company_id=$2",[employeeId,req.user.company_id]);
      employee=r.rows[0]||null;
    }
    const employeeName=employee?.name||"Employee";

    if(DEMO_MODE||!process.env.OPENAI_API_KEY){
      return res.json({text:`Suggested approach for ${employeeName}

1. Confirm the facts.
2. Ask for the employee's perspective.
3. Clarify expectations.
4. Document objectively.
5. Set a follow-up point.

Review against company policy before acting.`,mode:"demo"});
    }

    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    const context=[
      `Employee name: ${employeeName}`,
      employee?.position?`Position: ${employee.position}`:"",
      employee?.department?`Department: ${employee.department}`:"",
      category?`Category: ${category}`:"",
      `Manager notes: ${String(situation).trim()}`
    ].filter(Boolean).join("\n");

    const response=await client.responses.create({
      model:MODEL,
      instructions:systemPrompt(tool),
      input:context
    });
    const text=response.output_text?.trim();
    if(!text) throw new Error("No text returned.");
    res.json({text,mode:"live"});
  }catch(e){console.error(e);res.status(502).json({error:"AI service could not generate a response. Try again."});}
});

app.delete("/api/account", auth, async (req,res)=>{
  try{
    if(req.user.role!=="admin") return res.status(403).json({error:"Only an admin can delete the company account."});
    await pool.query("DELETE FROM companies WHERE id=$1",[req.user.company_id]);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not delete company account."});}
});

app.use((req,res)=>{
  if(req.path.startsWith("/api/")) return res.status(404).json({error:"Not found."});
  res.sendFile(path.join(__dirname,"public","index.html"));
});

initDb().then(()=>{
  app.listen(PORT,()=>{
    console.log(`HRCoach AI running at http://localhost:${PORT}`);
    console.log(`Demo mode: ${DEMO_MODE ? "ON" : "OFF"}`);
    console.log("Database: PostgreSQL");
    console.log(`Email mode: ${EMAIL_MODE}`);
  });
}).catch(e=>{
  console.error("Database initialization failed:",e);
  process.exit(1);
});