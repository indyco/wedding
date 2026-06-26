"use strict";

(function () {
  const app = document.getElementById("app");
  const params = new URLSearchParams(location.search);
  const initialEditToken = params.get("edit");

  function mount(node) {
    clearNode(app);
    app.appendChild(node);
  }

  function honeypot() {
    return h(
      "div",
      { class: "hp", "aria-hidden": "true" },
      h("label", {}, "Company", h("input", { type: "text", name: "company", tabindex: "-1", autocomplete: "off" }))
    );
  }

  function notice(msg, kind) {
    return h("div", { class: "notice " + (kind || "error") }, msg);
  }

  // ---- Lookup screen ------------------------------------------------------
  function renderLookup(message, messageKind) {
    const code = h("input", { type: "text", name: "code", placeholder: "e.g. SMITH123", autocomplete: "off" });
    const name = h("input", { type: "text", name: "name", placeholder: "Jane Doe", autocomplete: "off" });
    const hp = honeypot();
    const errorSlot = h("div", {});

    const form = h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          clearNode(errorSlot);
          const payload = {
            code: code.value.trim(),
            name: name.value.trim(),
            company: hp.querySelector("input").value,
          };
          if (!payload.code && !payload.name) {
            errorSlot.appendChild(notice("Please enter your invite code or your name."));
            return;
          }
          const r = await api("POST", "/api/lookup", payload);
          if (!r.ok) {
            errorSlot.appendChild(notice((r.data && r.data.error) || "Something went wrong. Please try again."));
            return;
          }
          const d = r.data;
          if (d.match === "unique") {
            renderForm(d.invitee, d.rsvp, null);
          } else if (d.match === "multiple") {
            const hints = (d.hints || []).filter(Boolean);
            let m = "We found more than one guest with that name. Please enter your invite code to continue.";
            if (hints.length) m += " (Is this you? " + hints.join(" / ") + ")";
            clearNode(errorSlot);
            errorSlot.appendChild(notice(m, "info"));
            code.focus();
          } else {
            clearNode(errorSlot);
            errorSlot.appendChild(
              notice("We couldn't find your invitation. Double-check the spelling, try your invite code, or contact the couple.")
            );
          }
        },
      },
      h("div", { class: "field" }, h("label", {}, "Invite code (preferred)"), code),
      h("div", { class: "divider" }, "or"),
      h("div", { class: "field" }, h("label", {}, "Your name, exactly as it appears on your invitation"), name),
      h("p", { class: "muted small" }, "Using your invite code is the most reliable way to find your invitation, but your name works too."),
      hp,
      errorSlot,
      h("button", { type: "submit" }, "Find my invitation")
    );

    mount(
      h(
        "div",
        {},
        h("h1", {}, "You're Invited"),
        h("p", { class: "subtitle" }, "We'd be delighted to have you — please RSVP"),
        message ? notice(message, messageKind || "info") : null,
        form
      )
    );
  }

  // ---- RSVP form ----------------------------------------------------------
  function renderForm(invitee, existing, editToken) {
    const max = (invitee.plus_ones_allotted || 0) + 1;
    const startAttendees =
      existing && existing.attendees && existing.attendees.length
        ? existing.attendees.map((a) => ({ name: a.name, dietary: a.dietary || "" }))
        : [{ name: "", dietary: "" }];
    let attendees = startAttendees.slice(0, max);
    let attending = existing ? !!existing.attending : true;

    const errorSlot = h("div", {});
    const attendeesWrap = h("div", {});
    const emailInput = h("input", { type: "email", name: "email", value: (existing && existing.email) || "", placeholder: "you@example.com" });
    const emailField = h("div", { class: "field" }, h("label", { id: "emailLabel" }, "Email"), emailInput);
    const messageInput = h("textarea", { name: "message", rows: "3", placeholder: "A note for the couple (optional)" }, (existing && existing.message) || "");
    const attendingWrap = h("div", { class: "field" });

    function renderAttendees() {
      clearNode(attendeesWrap);
      if (!attending) return;
      attendeesWrap.appendChild(h("label", {}, `Who's coming? (up to ${max})`));
      attendees.forEach((a, i) => {
        const nameI = h("input", { type: "text", value: a.name, placeholder: "Full name" });
        nameI.addEventListener("input", () => (attendees[i].name = nameI.value));
        const dietI = h("input", { type: "text", value: a.dietary, placeholder: "Dietary notes (optional)" });
        dietI.addEventListener("input", () => (attendees[i].dietary = dietI.value));
        const head = h(
          "div",
          { class: "rowhead" },
          h("strong", {}, i === 0 ? "Guest 1" : "Guest " + (i + 1)),
          attendees.length > 1
            ? h("button", { type: "button", class: "danger", onclick: () => { attendees.splice(i, 1); renderAttendees(); } }, "Remove")
            : null
        );
        attendeesWrap.appendChild(h("div", { class: "attendee-row" }, head, h("div", { class: "row" }, nameI, dietI)));
      });
      const addBtn = h(
        "button",
        {
          type: "button",
          class: "secondary",
          onclick: () => { if (attendees.length < max) { attendees.push({ name: "", dietary: "" }); renderAttendees(); } },
        },
        "+ Add guest"
      );
      if (attendees.length >= max) addBtn.disabled = true;
      attendeesWrap.appendChild(addBtn);
    }

    function renderAttendingChoice() {
      clearNode(attendingWrap);
      const mk = (val, label) => {
        const b = h("button", { type: "button", class: attending === val ? "" : "secondary", onclick: () => { attending = val; syncAttending(); } }, label);
        return b;
      };
      attendingWrap.appendChild(h("label", {}, "Will you be attending?"));
      attendingWrap.appendChild(h("div", { class: "row" }, mk(true, "Joyfully accept"), mk(false, "Regretfully decline")));
    }

    function syncAttending() {
      renderAttendingChoice();
      renderAttendees();
      document.getElementById("emailLabel").textContent = attending ? "Email (required — we'll send your confirmation)" : "Email (optional)";
    }

    const hp = honeypot();
    const form = h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          clearNode(errorSlot);
          const cleanAttendees = attendees.map((a) => ({ name: a.name.trim(), dietary: a.dietary.trim() })).filter((a) => a.name);
          if (attending && cleanAttendees.length === 0) {
            errorSlot.appendChild(notice("Please add at least one guest's name."));
            return;
          }
          const payload = {
            attending,
            attendees: cleanAttendees,
            email: emailInput.value.trim(),
            message: messageInput.value.trim(),
            company: hp.querySelector("input").value,
          };
          if (editToken) payload.editToken = editToken;
          const r = await api("POST", "/api/rsvp", payload);
          if (!r.ok) {
            errorSlot.appendChild(notice((r.data && r.data.error) || "Something went wrong. Please try again."));
            return;
          }
          renderConfirmation(r.data.attending);
        },
      },
      attendingWrap,
      attendeesWrap,
      emailField,
      h("div", { class: "field" }, h("label", {}, "Message"), messageInput),
      hp,
      errorSlot,
      h("button", { type: "submit" }, "Send RSVP")
    );

    mount(
      h(
        "div",
        {},
        h("h1", {}, "Hello, " + invitee.name + "!"),
        h("p", { class: "subtitle" }, existing ? "You can update your response below" : "We can't wait to hear from you"),
        form
      )
    );
    syncAttending();
  }

  // ---- Confirmation -------------------------------------------------------
  function renderConfirmation(attending) {
    mount(
      h(
        "div",
        { class: "center" },
        h("div", { class: "checkmark" }, attending ? "✓" : "♥"),
        h("h1", {}, "Thank you!"),
        h(
          "p",
          { class: "muted" },
          attending
            ? "Your RSVP is in — we can't wait to celebrate with you. A confirmation is on its way to your inbox, with a link to make changes if you need to."
            : "Thank you for letting us know. We'll miss you! If your plans change, use the link in your email to update your response."
        )
      )
    );
  }

  // ---- Boot ---------------------------------------------------------------
  async function start() {
    if (initialEditToken) {
      const r = await api("GET", "/api/rsvp?token=" + encodeURIComponent(initialEditToken));
      if (r.ok && r.data && r.data.invitee) {
        renderForm(r.data.invitee, r.data.rsvp, initialEditToken);
        return;
      }
      renderLookup("That edit link is invalid or has expired — please find your invitation below.", "error");
      return;
    }
    renderLookup();
  }

  start();
})();
