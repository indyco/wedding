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
    const code = h("input", { type: "text", name: "code", inputmode: "numeric", placeholder: "e.g. 12345-67890", autocomplete: "off" });
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
            company: hp.querySelector("input").value,
          };
          if (!payload.code) {
            errorSlot.appendChild(notice("Please enter the invite code from your invitation."));
            return;
          }
          const r = await api("POST", "/api/lookup", payload);
          if (!r.ok) {
            if (r.data && r.data.closed) {
              renderClosed(r.data.error);
              return;
            }
            errorSlot.appendChild(notice((r.data && r.data.error) || "Something went wrong. Please try again."));
            return;
          }
          const d = r.data;
          if (d.match === "unique") {
            renderForm(d.invitee, d.rsvp, null);
          } else {
            clearNode(errorSlot);
            errorSlot.appendChild(
              notice("We couldn't find that invite code. Double-check it against your invitation, or contact the couple.")
            );
          }
        },
      },
      h("div", { class: "field" }, h("label", {}, "Invite code"), code),
      h("p", { class: "muted small" }, "You'll find your invite code printed on your invitation."),
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
      // Solo (one occupant) vs. multi changes the whole treatment: solo is
      // card-less; multi anchors the primary and threads guests on a rail.
      const multi = attendees.length > 1;

      attendeesWrap.appendChild(
        h("p", { class: "att-cap" }, "Who's coming?", max > 1 ? h("span", { class: "att-cap-sub" }, ` (up to ${max})`) : null)
      );

      const list = h("div", { class: "attendees " + (multi ? "is-multi" : "is-solo") });
      attendees.forEach((a, i) => {
        const primary = i === 0;
        const nameI = h("input", { type: "text", value: a.name, placeholder: primary ? "Your full name" : "Full name" });
        nameI.addEventListener("input", () => (attendees[i].name = nameI.value));
        const dietI = h("input", { type: "text", value: a.dietary, placeholder: "e.g. vegetarian, no nuts" });
        dietI.addEventListener("input", () => (attendees[i].dietary = dietI.value));

        // Persistent labels — a filled field never loses its meaning.
        const who = h(
          "div",
          { class: "att-who" },
          h("div", { class: "att-f" }, h("label", { class: "flabel" }, primary ? "Your name" : "Full name"), nameI),
          h("div", { class: "att-f" }, h("label", { class: "flabel opt" }, "Dietary ", h("span", { class: "opttag" }, "optional")), dietI)
        );

        const row = h(
          "div",
          { class: "att " + (primary ? "att-primary" : "att-guest") },
          multi ? h("div", { class: "att-eyebrow" }, primary ? "You" : "Guest " + (i + 1)) : null,
          who
        );
        // The primary invitee is the anchor and is never removable; only
        // additional guests get the quiet corner "×".
        if (!primary) {
          row.appendChild(
            h(
              "button",
              {
                type: "button",
                class: "att-rm",
                title: "Remove",
                "aria-label": "Remove this guest",
                onclick: () => { attendees.splice(i, 1); renderAttendees(); },
              },
              "×"
            )
          );
        }
        list.appendChild(row);
      });
      attendeesWrap.appendChild(list);

      const addBtn = h(
        "button",
        {
          type: "button",
          class: "add-ghost",
          onclick: () => { if (attendees.length < max) { attendees.push({ name: "", dietary: "" }); renderAttendees(); } },
        },
        h("span", { class: "pl" }, "+"),
        " Add a guest"
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
            if (r.data && r.data.closed) {
              renderClosed(r.data.error);
              return;
            }
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
        h("h1", {}, "Hello, ", h("span", { class: "nowrap" }, invitee.name + "!")),
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
  function renderClosed(msg) {
    mount(
      h(
        "div",
        { class: "center" },
        h("h1", {}, "RSVPs are closed"),
        h("p", { class: "muted" }, msg || "Please contact the couple directly.")
      )
    );
  }

  async function start() {
    if (initialEditToken) {
      const r = await api("GET", "/api/rsvp?token=" + encodeURIComponent(initialEditToken));
      // Drop the token from the address bar either way, so it doesn't linger in
      // history or get copied out of the URL along with the link.
      history.replaceState({}, "", location.pathname);
      if (r.ok && r.data && r.data.invitee) {
        renderForm(r.data.invitee, r.data.rsvp, initialEditToken);
        return;
      }
      if (r.data && r.data.closed) {
        renderClosed(r.data.error);
        return;
      }
      renderLookup("That edit link is invalid or has expired — please find your invitation below.", "error");
      return;
    }
    renderLookup();
  }

  start();
})();
