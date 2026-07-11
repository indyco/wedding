"use strict";

(function () {
  const app = document.getElementById("app");
  let currentUser = "";

  const mount = (node) => { clearNode(app); app.appendChild(node); };
  const notice = (msg, kind) => h("div", { class: "notice " + (kind || "info") }, msg);
  const pill = (label, kind) => h("span", { class: "pill " + kind }, label);

  // Display an 8-digit invite code dashed ("1234-5678"); leave other values bare.
  function fmtCode(code) {
    const d = String(code == null ? "" : code).replace(/\D/g, "");
    return d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4) : d;
  }

  // A +/- stepper for the +1 allotment: a large minus (left) and plus (right)
  // button around an editable value. Returns { wrap, input } so callers can
  // still read input.value exactly like the old number field.
  function stepper(initial, opts) {
    opts = opts || {};
    const min = opts.min != null ? opts.min : 0;
    const max = opts.max != null ? opts.max : 20;
    const input = h("input", { type: "text", inputmode: "numeric", value: String(initial != null ? initial : 0), class: "stepper-val", "aria-label": "Plus-ones (+1s) allotted" });
    const clamp = (n) => Math.max(min, Math.min(max, isNaN(n) ? 0 : n));
    const read = () => clamp(parseInt(input.value, 10));
    const setVal = (n) => { input.value = String(clamp(n)); };
    const minus = h("button", { type: "button", class: "stepper-btn", "aria-label": "One fewer +1", onclick: () => setVal(read() - 1) }, "\u2212");
    const plus = h("button", { type: "button", class: "stepper-btn", "aria-label": "One more +1", onclick: () => setVal(read() + 1) }, "+");
    const wrap = h("div", { class: "stepper" }, minus, input, plus);
    return { wrap, input };
  }

  function guard(r) {
    if (r.status === 401) {
      renderLogin("Your session has expired. Please log in again.");
      return false;
    }
    return true;
  }

  // ---- Login --------------------------------------------------------------
  function renderLogin(message) {
    const u = h("input", { type: "text", autocomplete: "username", placeholder: "admin" });
    const p = h("input", { type: "password", autocomplete: "current-password" });
    const errorSlot = h("div", {});
    const form = h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          clearNode(errorSlot);
          const r = await api("POST", "/api/admin/login", { username: u.value.trim(), password: p.value });
          if (!r.ok) {
            errorSlot.appendChild(notice((r.data && r.data.error) || "Login failed", "error"));
            return;
          }
          currentUser = r.data.username;
          renderDashboard();
        },
      },
      h("div", { class: "field" }, h("label", {}, "Username"), u),
      h("div", { class: "field" }, h("label", {}, "Password"), p),
      errorSlot,
      h("button", { type: "submit" }, "Log in")
    );
    mount(h("div", { class: "login-box" }, h("h1", {}, "Admin sign-in"), message ? notice(message, "error") : null, form));
  }

  // ---- Dashboard shell ----------------------------------------------------
  const TABS = ["Summary", "Guests", "Responses", "Email", "Settings"];
  function renderDashboard(active) {
    const content = h("div", { class: "panel" }, "Loading…");
    const tabBar = h(
      "div",
      { class: "tabs" },
      TABS.map((t) =>
        h("button", { class: t === (active || "Summary") ? "active" : "", onclick: () => setTab(t) }, t)
      )
    );
    mount(
      h(
        "div",
        { class: "wrap" },
        h(
          "header",
          { class: "top" },
          h("h1", {}, "Wedding RSVP — Admin"),
          h(
            "div",
            {},
            h("span", { class: "muted small" }, "Signed in as " + currentUser + "  "),
            h("button", { class: "secondary", onclick: logout }, "Log out")
          )
        ),
        tabBar,
        content
      )
    );
    setTab(active || "Summary");

    function setTab(name, opts) {
      els(".tabs button").forEach((b) => b.classList.toggle("active", b.textContent === name));
      const r = { Summary: tabSummary, Guests: tabGuests, Responses: tabResponses, Email: tabEmail, Settings: tabSettings }[name];
      r(content, opts);
    }
    // expose for closures
    renderDashboard._setTab = setTab;
  }
  function setTab(name, opts) { renderDashboard._setTab(name, opts); }

  function els(sel) { return Array.from(document.querySelectorAll(sel)); }

  async function logout() {
    await api("POST", "/api/admin/logout", {});
    renderLogin("You've been logged out.");
  }

  // ---- Summary ------------------------------------------------------------
  async function tabSummary(content) {
    const r = await api("GET", "/api/admin/summary");
    if (!guard(r)) return;
    const s = r.data || {};
    const card = (n, l, filter) =>
      h(
        "div",
        filter
          ? { class: "stat stat-link", role: "button", tabindex: "0", title: "View in Responses",
              onclick: () => setTab("Responses", { filter }),
              onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTab("Responses", { filter }); } } }
          : { class: "stat" },
        h("div", { class: "n" }, String(n != null ? n : 0)),
        h("div", { class: "l" }, l)
      );
    clearNode(content);
    content.appendChild(
      h(
        "div",
        {},
        h(
          "div",
          { class: "cards" },
          card(s.invited, "Invited", "all"),
          card(s.responded, "Responded", "responded"),
          card(s.pending, "Awaiting reply", "pending"),
          card(s.attending_parties, "Parties attending", "yes"),
          card(s.declined, "Declined", "no"),
          card(s.headcount, "Total guests coming")
        ),
        h("p", { class: "muted small" }, "“Total guests coming” counts every named attendee across all accepted RSVPs.")
      )
    );
  }

  // ---- Guests -------------------------------------------------------------
  async function tabGuests(content) {
    const r = await api("GET", "/api/admin/invitees");
    if (!guard(r)) return;
    const invitees = r.data || [];
    clearNode(content);

    const msg = h("div", {});

    // Add-new row
    const nName = h("input", { placeholder: "Full name / household" });
    const nCode = h("input", { placeholder: "Code (optional)" });
    const allotAdd = stepper(0);
    const nAllot = allotAdd.input;
    const nHint = h("input", { placeholder: "Hint (optional)" });
    const nEmail = h("input", { placeholder: "Email (optional)" });
    const addBtn = h(
      "button",
      {
        onclick: async () => {
          if (!nName.value.trim()) { clearNode(msg); msg.appendChild(notice("Name is required", "error")); return; }
          const r2 = await api("POST", "/api/admin/invitees", {
            name: nName.value.trim(),
            invite_code: nCode.value.trim(),
            plus_ones_allotted: nAllot.value,
            disambiguation_hint: nHint.value.trim(),
            email: nEmail.value.trim(),
          });
          if (!guard(r2)) return;
          if (!r2.ok) { clearNode(msg); msg.appendChild(notice((r2.data && r2.data.error) || "Could not add", "error")); return; }
          setTab("Guests");
        },
      },
      "Add guest"
    );

    const addRow = h(
      "div",
      { class: "toolbar" },
      nName,
      nCode,
      h("label", { class: "steplabel" }, "+1s allotted", allotAdd.wrap),
      nHint,
      nEmail,
      addBtn
    );

    // CSV import/export
    const csvArea = h("textarea", { rows: "3", placeholder: "Paste CSV: name,plus_ones_allotted,email,invite_code,notes" });
    const importBtn = h(
      "button",
      {
        class: "secondary",
        onclick: async () => {
          const r2 = await api("POST", "/api/admin/invitees/import", { csv: csvArea.value });
          if (!guard(r2)) return;
          clearNode(msg);
          if (!r2.ok) { msg.appendChild(notice((r2.data && r2.data.error) || "Import failed", "error")); return; }
          const d = r2.data;
          let m = `Imported: ${d.inserted} added, ${d.updated} updated, ${d.skipped} skipped.`;
          if (d.errors && d.errors.length) m += " Issues: " + d.errors.map((e) => `row ${e.row}: ${e.error}`).join("; ");
          msg.appendChild(notice(m, d.errors && d.errors.length ? "error" : "info"));
          setTab("Guests");
        },
      },
      "Import CSV"
    );
    const exportLink = h("a", { href: "/api/admin/export.csv" }, h("button", { class: "secondary", type: "button" }, "Export CSV"));
    const catererLink = h("a", { href: "/api/admin/export-caterer.csv" }, h("button", { class: "secondary", type: "button" }, "Caterer CSV (dietary only)"));

    // Table
    const rows = invitees.map((inv) => {
      const cName = h("input", { value: inv.name, class: "col-name" });
      const cCode = h("input", { value: fmtCode(inv.invite_code), class: "col-code" });
      const allotRow = stepper(inv.plus_ones_allotted);
      const cAllot = allotRow.input;
      const cHint = h("input", { value: inv.disambiguation_hint || "" });
      const cEmail = h("input", { value: inv.email || "", class: "col-email", placeholder: "Email (optional)" });
      const status = inv.rsvp_id ? (inv.attending ? pill("Yes", "yes") : pill("No", "no")) : pill("Pending", "pending");
      const save = h(
        "button",
        {
          class: "small",
          onclick: async () => {
            const r2 = await api("PATCH", "/api/admin/invitees/" + inv.id, {
              name: cName.value.trim(),
              invite_code: cCode.value.trim(),
              plus_ones_allotted: cAllot.value,
              disambiguation_hint: cHint.value.trim(),
              email: cEmail.value.trim(),
            });
            if (!guard(r2)) return;
            clearNode(msg);
            msg.appendChild(notice(r2.ok ? `Saved ${cName.value.trim()}.` : (r2.data && r2.data.error) || "Save failed", r2.ok ? "info" : "error"));
          },
        },
        "Save"
      );
      const rsvpBtn = h(
        "button",
        { class: "small secondary", onclick: () => openRsvpModal(inv) },
        "RSVP"
      );
      const del = h(
        "button",
        {
          class: "small danger",
          onclick: async () => {
            if (!confirm(`Delete ${inv.name}? This also removes their RSVP.`)) return;
            const r2 = await api("DELETE", "/api/admin/invitees/" + inv.id);
            if (!guard(r2)) return;
            setTab("Guests");
          },
        },
        "Delete"
      );
      return h(
        "tr",
        {},
        h("td", {}, h("div", { class: "name-stack" }, cName, cEmail)),
        h("td", {}, cCode),
        h("td", {}, allotRow.wrap),
        h("td", {}, cHint),
        h("td", {}, status),
        h("td", {}, String(inv.party_size || 0)),
        h("td", {}, h("div", { class: "row" }, save, rsvpBtn, del))
      );
    });

    const table = h(
      "table",
      {},
      h(
        "thead",
        {},
        h("tr", {}, ["Name", "Code", "+1s allotted", "Hint", "Status", "Party", ""].map((t) => h("th", {}, t)))
      ),
      h("tbody", {}, rows)
    );

    content.appendChild(
      h(
        "div",
        {},
        h("h3", {}, "Add a guest"),
        addRow,
        h("h3", {}, "Bulk import / export"),
        h("div", { class: "field" }, csvArea),
        h("div", { class: "toolbar" }, importBtn, exportLink, catererLink),
        msg,
        h("h3", {}, `Guest list (${invitees.length})`),
        table
      )
    );
  }

  // ---- RSVP on behalf of a guest (admin) ----------------------------------
  async function openRsvpModal(inv) {
    // Pull any existing RSVP so editing doesn't clobber names already on file.
    let existing = null;
    const r = await api("GET", "/api/admin/rsvps?filter=all");
    if (!guard(r)) return;
    if (r.ok) existing = (r.data || []).find((x) => x.invitee_id === inv.id) || null;

    const max = (inv.plus_ones_allotted || 0) + 1;
    let attending = existing && existing.rsvp_id ? !!existing.attending : true;
    let attendees =
      existing && existing.attendees && existing.attendees.length
        ? existing.attendees.map((a) => ({ name: a.name, dietary: a.dietary || "" }))
        : [{ name: inv.name, dietary: "" }];
    attendees = attendees.slice(0, max);

    const emailInput = h("input", { type: "email", value: (existing && existing.email) || inv.email || "", placeholder: "Email (optional)" });
    const messageInput = h("textarea", { rows: "2", placeholder: "Message (optional)" }, (existing && existing.message) || "");
    const attendingWrap = h("div", { class: "field" });
    const attendeesWrap = h("div", {});
    const errorSlot = h("div", {});

    function renderAttendees() {
      clearNode(attendeesWrap);
      if (!attending) return;
      attendeesWrap.appendChild(h("label", {}, `Who's coming? (up to ${max})`));
      attendees.forEach((a, i) => {
        const nameI = h("input", { type: "text", value: a.name, placeholder: "Full name" });
        nameI.addEventListener("input", () => (attendees[i].name = nameI.value));
        const dietI = h("input", { type: "text", value: a.dietary, placeholder: "Dietary (optional)" });
        dietI.addEventListener("input", () => (attendees[i].dietary = dietI.value));
        const rm = attendees.length > 1
          ? h("button", { type: "button", class: "danger small", onclick: () => { attendees.splice(i, 1); renderAttendees(); } }, "Remove")
          : null;
        attendeesWrap.appendChild(h("div", { class: "attendee-row" }, h("div", { class: "row" }, nameI, dietI, rm)));
      });
      const addBtn = h("button", { type: "button", class: "secondary", onclick: () => { if (attendees.length < max) { attendees.push({ name: "", dietary: "" }); renderAttendees(); } } }, "+ Add guest");
      if (attendees.length >= max) addBtn.disabled = true;
      attendeesWrap.appendChild(addBtn);
    }

    function renderChoice() {
      clearNode(attendingWrap);
      const mk = (val, label) => h("button", { type: "button", class: attending === val ? "" : "secondary", onclick: () => { attending = val; renderChoice(); renderAttendees(); } }, label);
      attendingWrap.appendChild(h("label", {}, "Attending?"));
      attendingWrap.appendChild(h("div", { class: "row" }, mk(true, "Accepting"), mk(false, "Declining")));
    }

    const backdrop = h("div", { class: "modal-backdrop" });
    const close = () => { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); };
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

    const saveBtn = h(
      "button",
      {
        onclick: async () => {
          clearNode(errorSlot);
          const clean = attendees.map((a) => ({ name: a.name.trim(), dietary: a.dietary.trim() })).filter((a) => a.name);
          if (attending && clean.length === 0) { errorSlot.appendChild(notice("Add at least one guest's name.", "error")); return; }
          const r2 = await api("POST", "/api/admin/invitees/" + inv.id + "/rsvp", {
            attending,
            attendees: clean,
            email: emailInput.value.trim(),
            message: messageInput.value.trim(),
          });
          if (!guard(r2)) return;
          if (!r2.ok) { errorSlot.appendChild(notice((r2.data && r2.data.error) || "Could not save", "error")); return; }
          close();
          setTab("Guests");
        },
      },
      "Save RSVP"
    );
    const cancelBtn = h("button", { class: "secondary", type: "button", onclick: close }, "Cancel");

    const card = h(
      "div",
      { class: "modal-card" },
      h("h3", {}, "RSVP for " + inv.name),
      h("p", { class: "muted small" }, "Recording this on the guest's behalf. No confirmation email is sent."),
      attendingWrap,
      attendeesWrap,
      h("div", { class: "field" }, h("label", {}, "Email"), emailInput),
      h("div", { class: "field" }, h("label", {}, "Message"), messageInput),
      errorSlot,
      h("div", { class: "toolbar" }, saveBtn, cancelBtn)
    );
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    renderChoice();
    renderAttendees();
  }

  // ---- Responses ----------------------------------------------------------
  async function tabResponses(content, opts) {
    clearNode(content);
    const initial = (opts && opts.filter) || "all";
    const LABELS = { all: "All", responded: "Responded", yes: "Attending", no: "Declined", pending: "Pending" };
    const filter = h(
      "select",
      { style: "max-width:12rem", onchange: () => load(filter.value) },
      Object.keys(LABELS).map((v) => h("option", { value: v, selected: v === initial ? true : null }, LABELS[v]))
    );
    const tableWrap = h("div", {}, "Loading…");
    content.appendChild(h("div", {}, h("div", { class: "toolbar" }, h("label", { style: "margin:0" }, "Filter:"), filter), tableWrap));

    async function load(f) {
      const r = await api("GET", "/api/admin/rsvps?filter=" + encodeURIComponent(f || "all"));
      if (!guard(r)) return;
      const list = r.data || [];
      const rows = list.map((row) => {
        const status = row.rsvp_id ? (row.attending ? pill("Yes", "yes") : pill("No", "no")) : pill("Pending", "pending");
        const attendees = row.attendees || [];
        const party = attendees.length
          ? attendees.map((a) =>
              h(
                "div",
                { class: "guest-line" },
                a.name,
                a.dietary ? h("span", { class: "guest-diet" }, a.dietary) : null
              )
            )
          : "";
        return h(
          "tr",
          {},
          h("td", {}, row.name),
          h("td", {}, status),
          h("td", { class: "guests-cell" }, party),
          h("td", {}, row.email || ""),
          h("td", {}, row.message || "")
        );
      });
      clearNode(tableWrap);
      tableWrap.appendChild(
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["Invitee", "Status", "Guests (dietary)", "Email", "Message"].map((t) => h("th", {}, t)))),
          h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: "5", class: "muted" }, "No matching responses.")))
        )
      );
    }
    load(initial);
  }

  // ---- Email --------------------------------------------------------------
  async function tabEmail(content) {
    clearNode(content);
    const subject = h("input", { placeholder: "Subject" });
    const body = h("textarea", { rows: "6", placeholder: "Write your message to attending guests…" });
    const testTo = h("input", { placeholder: "your@email.com", style: "max-width:18rem" });
    const msg = h("div", {});

    const testBtn = h(
      "button",
      {
        class: "secondary",
        onclick: async () => {
          const r = await api("POST", "/api/admin/broadcast/test", { subject: subject.value, body: body.value, to: testTo.value.trim() });
          if (!guard(r)) return;
          clearNode(msg);
          msg.appendChild(notice(r.ok ? "Test email sent (or logged in dev)." : (r.data && r.data.error) || "Failed", r.ok ? "info" : "error"));
        },
      },
      "Send test to me"
    );
    const sendBtn = h(
      "button",
      {
        onclick: async () => {
          if (!confirm("Send this email to every guest who RSVP'd yes?")) return;
          const r = await api("POST", "/api/admin/broadcast", { subject: subject.value, body: body.value });
          if (!guard(r)) return;
          clearNode(msg);
          if (!r.ok) { msg.appendChild(notice((r.data && r.data.error) || "Failed", "error")); return; }
          msg.appendChild(notice(`Sent to ${r.data.sent} of ${r.data.total} (failed: ${r.data.failed}).`, "info"));
          loadLog();
        },
      },
      "Send to all attending"
    );

    const logWrap = h("div", {}, "");
    async function loadLog() {
      const r = await api("GET", "/api/admin/email-log?limit=50");
      if (!guard(r)) return;
      const rows = (r.data || []).map((e) =>
        h("tr", {}, h("td", {}, e.created_at), h("td", {}, e.recipient_email), h("td", {}, e.subject || ""), h("td", {}, e.status))
      );
      clearNode(logWrap);
      logWrap.appendChild(
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["When", "Recipient", "Subject", "Status"].map((t) => h("th", {}, t)))),
          h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: "4", class: "muted" }, "No emails sent yet.")))
        )
      );
    }

    content.appendChild(
      h(
        "div",
        {},
        h("h3", {}, "Compose broadcast"),
        h("div", { class: "field" }, h("label", {}, "Subject"), subject),
        h("div", { class: "field" }, h("label", {}, "Message"), body),
        h("div", { class: "toolbar" }, h("label", { style: "margin:0" }, "Test to:"), testTo, testBtn, h("span", { class: "spacer" }), sendBtn),
        msg,
        h("h3", {}, "Recent emails"),
        logWrap
      )
    );
    loadLog();
  }

  // ---- Settings -----------------------------------------------------------
  function tabSettings(content) {
    clearNode(content);
    const cur = h("input", { type: "password", autocomplete: "current-password" });
    const newU = h("input", { type: "text", placeholder: currentUser, autocomplete: "username" });
    const newP = h("input", { type: "password", autocomplete: "new-password" });
    const msg = h("div", {});
    const form = h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          clearNode(msg);
          const r = await api("POST", "/api/admin/change-credentials", {
            currentPassword: cur.value,
            newUsername: newU.value.trim(),
            newPassword: newP.value,
          });
          if (!guard(r)) return;
          if (!r.ok) { msg.appendChild(notice((r.data && r.data.error) || "Update failed", "error")); return; }
          currentUser = r.data.username;
          cur.value = ""; newP.value = "";
          msg.appendChild(notice("Credentials updated.", "info"));
          renderDashboard("Settings");
        },
      },
      h("div", { class: "field" }, h("label", {}, "Current password (required)"), cur),
      h("div", { class: "field" }, h("label", {}, "New username (leave blank to keep)"), newU),
      h("div", { class: "field" }, h("label", {}, "New password (leave blank to keep)"), newP),
      msg,
      h("button", { type: "submit" }, "Update credentials")
    );
    content.appendChild(h("div", {}, h("h3", {}, "Change admin credentials"), form));
  }

  // ---- Boot ---------------------------------------------------------------
  async function start() {
    const r = await api("GET", "/api/me");
    if (r.ok && r.data && r.data.authenticated) {
      currentUser = r.data.username;
      renderDashboard();
    } else {
      renderLogin();
    }
  }

  start();
})();
