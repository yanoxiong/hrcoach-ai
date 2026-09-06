const state={token:localStorage.getItem("hrcoach_token")||"",user:null,employees:[],records:[],route:"home",health:null};
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];

function toast(m){
  const e=$("#toast");
  e.textContent=m;
  e.classList.remove("hidden");
  clearTimeout(window.__t);
  window.__t=setTimeout(()=>e.classList.add("hidden"),3500);
}

async function api(path,opt={}){
  const h={"Content-Type":"application/json",...(opt.headers||{})};
  if(state.token)h.Authorization=`Bearer ${state.token}`;
  const r=await fetch(path,{...opt,headers:h});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){
    const e=new Error(d.error||"Request failed.");
    e.code=d.code;
    throw e;
  }
  return d;
}

function hidePanels(){
  ["#normalAuth","#verifyPanel","#resetForm","#messagePanel"].forEach(s=>$(s)?.classList.add("hidden"));
}

function setAuthMode(m){
  $("#normalAuth").classList.remove("hidden");
  $("#loginForm").classList.toggle("hidden",m!=="login");
  $("#registerForm").classList.toggle("hidden",m!=="register");
  $("#forgotForm").classList.add("hidden");
  $("#loginTab").classList.toggle("active",m==="login");
  $("#registerTab").classList.toggle("active",m==="register");
}

function backToLogin(){
  hidePanels();
  $("#normalAuth").classList.remove("hidden");
  setAuthMode("login");
  history.replaceState({}, "", location.pathname);
}

function showMessage(t,m){
  hidePanels();
  $("#messageTitle").textContent=t;
  $("#messageText").textContent=m;
  $("#messagePanel").classList.remove("hidden");
}

$("#loginTab").onclick=()=>setAuthMode("login");
$("#registerTab").onclick=()=>setAuthMode("register");
$("#forgotBtn").onclick=()=>{
  $("#loginForm").classList.add("hidden");
  $("#registerForm").classList.add("hidden");
  $("#forgotForm").classList.remove("hidden");
};
$("#backToLogin").onclick=backToLogin;
$("#messageBackBtn").onclick=backToLogin;
$("#verifyBackBtn").onclick=backToLogin;

$("#registerForm").onsubmit=async e=>{
  e.preventDefault();
  try{
    const d=await api("/api/auth/register",{
      method:"POST",
      body:JSON.stringify({
        name:$("#registerName").value,
        companyName:$("#registerCompany").value,
        email:$("#registerEmail").value,
        password:$("#registerPassword").value
      })
    });

    if(d.verificationRequired){
      showMessage("Verify your email",d.message);
      return;
    }

    state.token=d.token;
    localStorage.setItem("hrcoach_token",state.token);
    boot();
  }catch(err){
    toast(err.message);
  }
};

$("#loginForm").onsubmit=async e=>{
  e.preventDefault();

  try{
    const d=await api("/api/auth/login",{
      method:"POST",
      body:JSON.stringify({
        email:$("#loginEmail").value,
        password:$("#loginPassword").value
      })
    });

    state.token=d.token;
    localStorage.setItem("hrcoach_token",state.token);
    boot();
  }catch(err){
    toast(err.message);

    if(err.code==="EMAIL_NOT_VERIFIED" && confirm("Send a new verification link?")){
      const d=await api("/api/auth/resend-verification",{
        method:"POST",
        body:JSON.stringify({email:$("#loginEmail").value})
      });
      showMessage("Verification link sent",d.message);
    }
  }
};

$("#forgotForm").onsubmit=async e=>{
  e.preventDefault();

  try{
    const d=await api("/api/auth/forgot-password",{
      method:"POST",
      body:JSON.stringify({email:$("#forgotEmail").value})
    });

    showMessage("Check your email",d.message);
  }catch(err){
    toast(err.message);
  }
};

$("#resetForm").onsubmit=async e=>{
  e.preventDefault();

  const token=new URLSearchParams(location.search).get("reset");

  try{
    const d=await api("/api/auth/reset-password",{
      method:"POST",
      body:JSON.stringify({
        token,
        password:$("#resetPassword").value
      })
    });

    showMessage("Password updated",d.message);
  }catch(err){
    toast(err.message);
  }
};

async function handleMagicLinks(){
  const p=new URLSearchParams(location.search);
  const v=p.get("verify");
  const r=p.get("reset");

  if(v){
    hidePanels();
    $("#verifyPanel").classList.remove("hidden");
    $("#verifyMessage").textContent="Checking verification link…";

    try{
      const d=await api("/api/auth/verify-email",{
        method:"POST",
        body:JSON.stringify({token:v})
      });

      $("#verifyMessage").textContent=d.message;
    }catch(err){
      $("#verifyMessage").textContent=err.message;
    }

    return true;
  }

  if(r){
    hidePanels();
    $("#resetForm").classList.remove("hidden");
    return true;
  }

  return false;
}

$("#logoutBtn").onclick=()=>{
  state.token="";
  localStorage.removeItem("hrcoach_token");
  $("#appView").classList.add("hidden");
  $("#authView").classList.remove("hidden");
  backToLogin();
};

$$(".nav").forEach(b=>b.onclick=()=>{
  state.route=b.dataset.route;
  $$(".nav").forEach(x=>x.classList.toggle("active",x.dataset.route===state.route));
  render();
});

async function boot(){
  state.health=await api("/api/health");

  if(await handleMagicLinks()){
    $("#authView").classList.remove("hidden");
    $("#appView").classList.add("hidden");
    return;
  }

  if(!state.token){
    $("#authView").classList.remove("hidden");
    $("#appView").classList.add("hidden");
    return;
  }

  try{
    state.user=await api("/api/me");

    const checkout=new URLSearchParams(location.search).get("checkout");

    if(checkout==="success"){
      toast("Your 14-day trial has started successfully.");
      history.replaceState({},"",location.pathname);
      setTimeout(async()=>{
        try{
          state.user=await api("/api/me");
          if(state.route==="account")render();
        }catch{}
      },2500);
    }

    if(checkout==="cancelled"){
      toast("Checkout was cancelled. No subscription was started.");
      history.replaceState({},"",location.pathname);
    }

    [state.employees,state.records]=await Promise.all([
      api("/api/employees"),
      api("/api/records")
    ]);

    $("#companyName").textContent=state.user.company_name;
    $("#modeBadge").textContent=state.health.demoMode?"Demo AI":"Live AI";

    $("#authView").classList.add("hidden");
    $("#appView").classList.remove("hidden");

    state.route="home";
    render();

  }catch(err){
    state.token="";
    localStorage.removeItem("hrcoach_token");
    toast(err.message);
    backToLogin();
  }
}

function esc(v=""){
  return String(v).replace(/[&<>"']/g,c=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#039;'
  }[c]));
}

function opts(){
  return `<option value="">No employee selected</option>`+
    state.employees.map(e=>`<option value="${e.id}">${esc(e.name)}</option>`).join("");
}

function card(t,d,r){
  return `
    <div class="card tool">
      <h3>${t}</h3>
      <p>${d}</p>
      <div style="margin-top:14px">
        <button class="primary route-btn" data-route="${r}">Open</button>
      </div>
    </div>
  `;
}

function bindRoutes(){
  $$(".route-btn").forEach(b=>b.onclick=()=>{
    state.route=b.dataset.route;
    render();
  });
}

function render(){
  if(state.route==="home"){
    $("#main").innerHTML=`
      <section class="hero">
        <h1>What do you need help with today?</h1>
        <p>Prepare conversations, create objective drafts, and recognize good work.</p>
      </section>

      <section class="grid">
        ${card("Ask HRCoach","Structured manager guidance.","ask")}
        ${card("Document an Issue","Objective draft.","documentation")}
        ${card("Difficult Conversation","Conversation plan.","conversation")}
        ${card("Recognize an Employee","Recognition message.","recognition")}
      </section>
    `;

    bindRoutes();
    return;
  }

  if(state.route==="tools"){
    state.route="home";
    return render();
  }

  if(state.route==="employees"){
    $("#main").innerHTML=`
      <h2 class="section-title">Employees</h2>
      <div class="stack">
        ${
          state.employees.map(e=>`
            <div class="card">
              <h3>${esc(e.name)}</h3>
              <p>${esc(e.position||"")} · ${esc(e.department||"")}</p>
            </div>
          `).join("")
        }
      </div>
    `;
    return;
  }

  if(state.route==="history"){
    $("#main").innerHTML=`
      <h2 class="section-title">History</h2>
      <div class="stack">
        ${
          state.records.map(r=>`
            <div class="card">
              <span class="badge">${esc(r.type)}</span>
              <h3>${esc(r.employee_name||"No employee")}</h3>
              <details>
                <summary>View</summary>
                <div class="result">${esc(r.output_text)}</div>
              </details>
            </div>
          `).join("") ||
          "<div class='card'><p>No saved records yet.</p></div>"
        }
      </div>
    `;
    return;
  }

 if(state.route==="account"){
  const status=state.user.subscription_status||"No subscription";
  const plan=state.user.subscription_plan||"No plan";
  const hasSubscription=["trialing","active","past_due"].includes(status);
  const cancelling=Boolean(state.user.cancel_at_period_end);
   const aiUsed=Number(state.user.ai_requests_used||0);
const aiLimit=Number(state.user.ai_request_limit||0);
const aiRemaining=Number(state.user.ai_requests_remaining||0);
    $("#main").innerHTML=`
      <h2 class="section-title">Account & Billing</h2>

      <div class="stack">

        <div class="card">
          <h3>${esc(state.user.company_name)}</h3>
          <p>
            ${esc(state.user.email)} ·
            ${state.user.email_verified?"Verified":"Not verified"}
          </p>

${
  aiLimit>0
    ? `<div style="margin-top:16px">
         <h4>AI Usage</h4>
         <p><strong>${aiUsed}</strong> of <strong>${aiLimit}</strong> requests used this month</p>
         <p><strong>${aiRemaining}</strong> requests remaining</p>
       </div>`
    : ""
}

          <p>
            <strong>Subscription status:</strong>
            ${esc(status)}
          </p>

          <p>
            <strong>Current plan:</strong>
            ${esc(plan)}
          </p>

          ${
            state.user.trial_ends_at
              ? `<p><strong>Trial ends:</strong> ${new Date(state.user.trial_ends_at).toLocaleDateString()}</p>`
              : ""
          }

          ${
  cancelling
    ? `<p><strong>Cancellation:</strong> Scheduled to end at the end of the current trial/billing period.</p>`
    : ""
}
        </div>

              <div class="grid">

        <div class="card">
          <h3>Founding Manager</h3>
          <p><strong>$29.99/month</strong></p>
          <p>14-day free trial.</p>
          <p>Credit card required. Billing begins automatically after the trial unless canceled.</p>

          ${
            hasSubscription
              ? plan==="founding"
                ? `<button class="secondary" disabled>Current Plan ✓</button>`
                : `<button class="secondary" disabled>Available through Manage Billing</button>`
              : `<button class="primary plan-btn" data-plan="founding">Start 14-Day Trial</button>`
          }
        </div>

        <div class="card">
          <h3>Business</h3>
          <p><strong>$59.99/month</strong></p>
          <p>14-day free trial.</p>
          <p>Credit card required. Billing begins automatically after the trial unless canceled.</p>

          ${
            hasSubscription
              ? plan==="business"
                ? `<button class="secondary" disabled>Current Plan ✓</button>`
                : `<button class="secondary" disabled>Upgrade through Manage Billing</button>`
              : `<button class="primary plan-btn" data-plan="business">Start 14-Day Trial</button>`
          }
        </div>

      </div>

      ${
        state.user.stripe_customer_id
          ? `<div class="card">
               <h3>Manage Subscription</h3>
               <p>Change your plan, update payment information, review billing, or cancel your subscription.</p>
               <button id="billingPortal" class="secondary">
                 Manage Billing
               </button>
             </div>`
          : ""
      }

    </div>
    `;

    $$(".plan-btn").forEach(b=>{
      b.onclick=async()=>{
        try{
          b.disabled=true;
          b.textContent="Opening Stripe…";

          const d=await api("/api/billing/checkout",{
            method:"POST",
            body:JSON.stringify({plan:b.dataset.plan})
          });

          if(!d.url)throw new Error("Stripe Checkout URL was not returned.");

          window.location.href=d.url;

        }catch(err){
          toast(err.message);
          b.disabled=false;
          b.textContent="Start 14-Day Trial";
        }
      };
    });

    const portal=$("#billingPortal");

    if(portal){
      portal.onclick=async()=>{
        try{
          portal.disabled=true;
          portal.textContent="Opening billing…";

          const d=await api("/api/billing/portal",{
            method:"POST"
          });

          if(!d.url)throw new Error("Billing portal URL was not returned.");

          window.location.href=d.url;

        }catch(err){
          toast(err.message);
          portal.disabled=false;
          portal.textContent="Manage Billing";
        }
      };
    }

    return;
  }

  const meta={
    ask:[
      "Ask HRCoach",
      ["General","Attendance","Performance","Conflict","Conduct","Communication","Safety","Other"],
      "Generate guidance"
    ],

    documentation:[
      "Documentation Assistant",
      ["Attendance","Performance","Conduct","Safety","Customer Complaint","Other"],
      "Generate draft"
    ],

    conversation:[
      "Difficult Conversation Coach",
      ["Attendance","Performance","Conflict","Conduct","Safety","Other"],
      "Build conversation"
    ],

    recognition:[
      "Employee Recognition",
      ["Teamwork","Leadership","Customer Service","Reliability","Safety","Going Above and Beyond"],
      "Generate recognition"
    ]
  }[state.route];

  if(meta){
    $("#main").innerHTML=`
      <h2 class="section-title">${meta[0]}</h2>

      <div class="card stack">
        <label>
          Employee
          <select id="employeeId">
            ${opts()}
          </select>
        </label>

        <label>
          Category
          <select id="category">
            ${meta[1].map(x=>`<option>${x}</option>`).join("")}
          </select>
        </label>

        <label>
          Manager notes
          <textarea id="situation"></textarea>
        </label>

        <button id="generateBtn" class="primary">
          ${meta[2]}
        </button>

        <div id="output"></div>
      </div>
    `;

    $("#generateBtn").onclick=async()=>{
      const employeeId=$("#employeeId").value
        ? Number($("#employeeId").value)
        : null;

      const category=$("#category").value;
      const situation=$("#situation").value.trim();

      if(!situation){
        return toast("Enter the situation first.");
      }

      try{
        $("#generateBtn").disabled=true;
        $("#generateBtn").textContent="Generating…";

        const d=await api("/api/ai/generate",{
          method:"POST",
          body:JSON.stringify({
            tool:state.route,
            employeeId,
            category,
            situation
          })
        });

        $("#output").innerHTML=`
          <div class="result">${esc(d.text)}</div>
          <button id="saveResult" class="secondary" style="margin-top:10px">
            Save record
          </button>
        `;

        $("#saveResult").onclick=async()=>{
          await api("/api/records",{
            method:"POST",
            body:JSON.stringify({
              employeeId,
              type:state.route,
              category,
              inputText:situation,
              outputText:d.text
            })
          });

          state.records=await api("/api/records");
          toast("Saved.");
        };

      }catch(err){
        toast(err.message);

      }finally{
        $("#generateBtn").disabled=false;
        $("#generateBtn").textContent=meta[2];
      }
    };
  }
}

boot();
