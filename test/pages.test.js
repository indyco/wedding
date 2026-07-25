"use strict";

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { open } = require("../lib/db");
const { createApp } = require("../lib/app");

function app() {
  const store = open(":memory:");
  return createApp({ store, config: { sessionSecret: "t" } });
}

test("serves the guest page at /", async () => {
  const res = await request(app()).get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /html/);
  assert.match(res.text, /You're Invited/);
});

test("serves the admin page at /admin", async () => {
  const res = await request(app()).get("/admin");
  assert.equal(res.status, 200);
  assert.match(res.text, /Admin/);
});

test("serves static assets", async () => {
  const css = await request(app()).get("/css/styles.css");
  assert.equal(css.status, 200);
  const js = await request(app()).get("/js/guest.js");
  assert.equal(js.status, 200);
});

test("unknown API route returns JSON 404", async () => {
  const res = await request(app()).get("/api/nope");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "Not found");
});

test("baseline security headers are present", async () => {
  const res = await request(app()).get("/");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.ok(res.headers["content-security-policy"]);
});

test("the front-end has no raw-HTML sink", async () => {
  // Guest-supplied names and messages are rendered through these files; every
  // path must produce text nodes, never parsed markup. Comments are stripped
  // first so prose about innerHTML doesn't count as a use of it.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const file of ["/js/common.js", "/js/guest.js", "/js/admin.js"]) {
    const res = await request(app()).get(file);
    assert.equal(res.status, 200);
    const code = stripComments(res.text);
    assert.equal(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code),
      false,
      `raw-HTML sink in ${file}`
    );
  }
});
