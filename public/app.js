const state = {
  token: localStorage.getItem("hrcoach_token") || "",
  user: null,
  employees: [],
  records: [],
  route: "home",
  health: null
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => el.classList.add("hidden"), 3000);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) logout(false);
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function setAuthMode(mode) {
  $("#loginTab").classList.toggle("active", mode === "login");
  $("#registerTab").classList.toggle("active", mode === "register");
  $("#loginForm").classList.toggle("hidden", mode !== "login");
  $("#registerForm").classList.toggle("hidden", mode !== "register");
}

$("#loginTab").onclick = () => setAuthMode("login");
$("#registerTab").onclick = () => setAuthMode("register");

$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: $("#loginEmail").value, password: $("#loginPassword").value })
    });
    state.token = data.token;
    localStorage.setItem("hrcoach_token", state.token);
    await boot();
  } catch (err) { toast(err.message); }
};

$("#registerForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: $("#registerName").value,
        companyName: $("#registerCompany").value,
        email: $("#registerEmail").value,
        password: $("#registerPassword").value
      })
    });
    state.token = data.token;
    localStorage.setItem("hrcoach_token", state.token);
    await boot();
  } catch (err) { toast(err.message); }
};

$("#logoutBtn").onclick = () => logout(true);
function logout(show = true) {
  state.token = "";
  state.user = null;
  localStorage.removeItem("hrcoach_token");
  $("#appView").classList.add("hidden");
  $("#authView").classList.remove("hidden");
  if (show) toast("Signed out.");
}

$$(".nav").forEach(btn => btn.onclick = () => setRoute(btn.dataset.route));

function setRoute(route) {
  state.route = route;
  $$(".nav").forEach(b => b.classList.toggle("active", b.dataset.route === route));
  render();
}

async function boot() {
  try {
    state.health = await api("/api/health");
    if (!state.token) {
      $("#authView").classList.remove("hidden");
      $("#appView").classList.add("hidden");
      return;
    }
    state.user = await api("/api/me");
    [state.employees, state.records] = await Promise.all([api("/api/employees"), api("/api/records")]);
    $("#companyName").textContent = state.user.company_name;
    $("#modeBadge").textContent = state.health.demoMode ? "Demo AI" : "Live AI";
    $("#authView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    setRoute("home");
  } catch (err) {
    console.error(err);
    logout(false);
    toast(err.message);
  }
}

function toolCard(title, desc, route) {
  return `<div class="card tool"><h3>${title}</h3><p>${desc}</p><div style="margin-top:14px"><button class="primary route-btn" data-route="${route}">Open</button></div></div>`;
}
function bindRoutes() {
  $$(".route-btn").forEach(b => b.onclick = () => setRoute(b.dataset.route));
}
function empOptions(selected = "") {
  return `<option value="">No employee selected</option>` + state.employees.map(e =>
    `<option value="${e.id}" ${String(e.id)===String(selected)?"selected":""}>${escapeHtml(e.name)}</option>`
  ).join("");
}
function escapeHtml(value="") {
  return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
}

function render() {
  if (state.route === "home") return renderHome();
  if (state.route === "employees") return renderEmployees();
  if (state.route === "tools") return renderTools();
  if (state.route === "history") return renderHistory();
  if (state.route === "account") return renderAccount();
  if (state.route === "ask") return renderAI("ask");
  if (state.route === "documentation") return renderAI("documentation");
  if (state.route === "conversation") return renderAI("conversation");
  if (state.route === "recognition") return renderAI("recognition");
}

function renderHome() {
  $("#main").innerHTML = `
    <section class="hero">
      <h1>What do you need help with today?</h1>
      <p>Prepare for employee conversations, create objective drafts, recognize good work, and keep a record of manager activity.</p>
    </section>
    <section class="grid">
      ${toolCard("Ask HRCoach","Describe a workplace situation and get structured management guidance.","ask")}
      ${toolCard("Document an Issue","Turn factual notes into a neutral professional draft.","documentation")}
      ${toolCard("Difficult Conversation","Build a respectful conversation plan.","conversation")}
      ${toolCard("Recognize an Employee","Create polished recognition in seconds.","recognition")}
    </section>
    <section class="kpis">
      <div class="card"><div class="kpi">${state.employees.length}</div><div class="muted">Employees</div></div>
      <div class="card"><div class="kpi">${state.records.length}</div><div class="muted">Saved records</div></div>
      <div class="card"><div class="kpi">${state.health?.demoMode ? "Demo" : "Live"}</div><div class="muted">AI mode</div></div>
    </section>`;
  bindRoutes();
}

function renderTools() {
  $("#main").innerHTML = `<h2 class="section-title">Manager tools</h2><p class="section-sub">Choose a workflow.</p>
    <div class="grid">
      ${toolCard("Ask HRCoach","Structured guidance and practical next steps.","ask")}
      ${toolCard("Documentation Assistant","Objective documentation draft.","documentation")}
      ${toolCard("Conversation Coach","Talking points for difficult conversations.","conversation")}
      ${toolCard("Recognition","Positive employee recognition.","recognition")}
    </div>`;
  bindRoutes();
}

const toolMeta = {
  ask: {
    title:"Ask HRCoach", sub:"Describe the situation using specific, factual details.",
    categories:["General","Attendance","Performance","Conflict","Conduct","Communication","Safety","Other"],
    button:"Generate guidance"
  },
  documentation: {
    title:"Documentation Assistant", sub:"Turn manager notes into an objective draft.",
    categories:["Attendance","Performance","Conduct","Safety","Customer Complaint","Policy/Procedure","Other"],
    button:"Generate draft"
  },
  conversation: {
    title:"Difficult Conversation Coach", sub:"Prepare a clear, respectful conversation structure.",
    categories:["Attendance","Performance","Conflict","Customer Complaint","Conduct","Productivity","Communication","Safety","Other"],
    button:"Build conversation"
  },
  recognition: {
    title:"Employee Recognition", sub:"Turn a quick note into a polished recognition message.",
    categories:["Teamwork","Leadership","Customer Service","Reliability","Safety","Going Above and Beyond"],
    button:"Generate recognition"
  }
};

function renderAI(tool) {
  const m = toolMeta[tool];
  $("#main").innerHTML = `
    <h2 class="section-title">${m.title}</h2><p class="section-sub">${m.sub}</p>
    <div class="card stack">
      <label>Employee<select id="employeeId">${empOptions()}</select></label>
      <label>Category<select id="category">${m.categories.map(x=>`<option>${x}</option>`).join("")}</select></label>
      <label>Manager notes<textarea id="situation" placeholder="Describe only what you observed, what was reported, and relevant dates/context."></textarea></label>
      <button id="generateBtn" class="primary">${m.button}</button>
      <div class="notice">HRCoach supports managers; it does not make employment decisions or provide legal advice. Review outputs against company policy and involve HR or qualified counsel for sensitive matters.</div>
      <div id="output"></div>
    </div>`;
  $("#generateBtn").onclick = async () => {
    const employeeId = $("#employeeId").value ? Number($("#employeeId").value) : null;
    const category = $("#category").value;
    const situation = $("#situation").value.trim();
    if (!situation) return toast("Enter the situation first.");
    $("#generateBtn").disabled = true;
    $("#generateBtn").textContent = "Generating…";
    try {
      const data = await api("/api/ai/generate", {
        method:"POST",
        body: JSON.stringify({ tool, employeeId, category, situation })
      });
      $("#output").innerHTML = `<div class="result">${escapeHtml(data.text)}</div>
        <div class="row" style="margin-top:12px">
          <button id="saveResult" class="secondary">Save record</button>
          <span class="badge">${data.mode === "live" ? "Live AI" : "Demo AI"}</span>
        </div>`;
      $("#saveResult").onclick = async () => {
        try {
          await api("/api/records", {
            method:"POST",
            body: JSON.stringify({
              employeeId, type: tool, category, inputText: situation, outputText: data.text
            })
          });
          state.records = await api("/api/records");
          toast("Saved.");
        } catch (err) { toast(err.message); }
      };
    } catch (err) { toast(err.message); }
    finally {
      $("#generateBtn").disabled = false;
      $("#generateBtn").textContent = m.button;
    }
  };
}

function renderEmployees() {
  $("#main").innerHTML = `
    <h2 class="section-title">Employees</h2><p class="section-sub">Manage the employees attached to this business account.</p>
    <div class="card stack">
      <h3 style="margin:0">Add employee</h3>
      <div class="grid" style="margin-top:0">
        <label>Name<input id="newName" /></label>
        <label>Position<input id="newPosition" /></label>
        <label>Department<input id="newDepartment" /></label>
        <label>Start date<input id="newStart" type="date" /></label>
      </div>
      <button id="addEmployee" class="primary">Add employee</button>
    </div>
    <div class="stack" style="margin-top:15px">
      ${state.employees.map(e=>`
        <div class="card employee">
          <div><h3>${escapeHtml(e.name)}</h3><div class="muted">${escapeHtml(e.position || "No position")} · ${escapeHtml(e.department || "No department")}</div><div style="margin-top:8px"><span class="badge">${escapeHtml(e.start_date || "No start date")}</span></div></div>
          <button class="danger delete-employee" data-id="${e.id}">Delete</button>
        </div>`).join("")}
    </div>`;
  $("#addEmployee").onclick = async () => {
    const name = $("#newName").value.trim();
    if (!name) return toast("Employee name is required.");
    try {
      await api("/api/employees", {
        method:"POST",
        body: JSON.stringify({
          name, position:$("#newPosition").value, department:$("#newDepartment").value, startDate:$("#newStart").value
        })
      });
      state.employees = await api("/api/employees");
      renderEmployees();
      toast("Employee added.");
    } catch (err) { toast(err.message); }
  };
  $$(".delete-employee").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this employee profile? Saved records will remain but lose the employee link.")) return;
    try {
      await api(`/api/employees/${b.dataset.id}`, { method:"DELETE" });
      state.employees = await api("/api/employees");
      state.records = await api("/api/records");
      renderEmployees();
      toast("Employee deleted.");
    } catch (err) { toast(err.message); }
  });
}

function renderHistory() {
  $("#main").innerHTML = `<h2 class="section-title">History</h2><p class="section-sub">Saved management-support records for this business.</p>
    <div class="stack">
      ${state.records.length ? state.records.map(r=>`
        <div class="card history">
          <div class="row"><span class="badge">${escapeHtml(r.type)}</span><span class="muted">${new Date(r.created_at+"Z").toLocaleString()}</span></div>
          <h3>${escapeHtml(r.employee_name || "No employee selected")}</h3>
          <p>${escapeHtml(r.category || "")}</p>
          <details style="margin-top:10px"><summary>View saved output</summary><div class="result" style="margin-top:10px">${escapeHtml(r.output_text)}</div></details>
        </div>`).join("") : `<div class="card"><p>No saved records yet.</p></div>`}
    </div>`;
}

function renderAccount() {
  $("#main").innerHTML = `
    <h2 class="section-title">Account</h2><p class="section-sub">Business and security settings.</p>
    <div class="stack">
      <div class="card"><h3>${escapeHtml(state.user.company_name)}</h3><p>${escapeHtml(state.user.name)} · ${escapeHtml(state.user.email)} · ${escapeHtml(state.user.role)}</p></div>
      <div class="card"><h3>AI mode</h3><p>${state.health.demoMode ? "Demo mode is on. The server uses built-in responses and no AI charges." : `Live AI is on using ${escapeHtml(state.health.model)}.`}</p></div>
      <div class="card"><h3>Production checklist</h3><p>Before storing confidential employee data: complete a security review, privacy policy, terms, retention/deletion rules, backups, incident response, and appropriate legal/compliance review.</p></div>
      <div class="card"><h3>Delete account</h3><p>This permanently deletes the company, users, employees, and records in this MVP.</p><div style="margin-top:12px"><button id="deleteAccount" class="danger">Delete company account</button></div></div>
    </div>`;
  $("#deleteAccount").onclick = async () => {
    if (!confirm("Permanently delete this entire HRCoach company account?")) return;
    try {
      await api("/api/account", { method:"DELETE" });
      logout(false); toast("Company account deleted.");
    } catch (err) { toast(err.message); }
  };
}

boot();
