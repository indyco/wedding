"use strict";

/* Shared helpers for the guest and admin pages (no inline scripts — CSP-safe). */

window.api = async function api(method, url, body) {
  const opts = { method, headers: { "X-Requested-With": "XMLHttpRequest" } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* non-JSON response */
  }
  return { ok: res.ok, status: res.status, data };
};

/* Create an element: h("div", {class, text, onclick, ...attrs}, ...children) */
window.h = function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return node;
};

window.clearNode = function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
};
