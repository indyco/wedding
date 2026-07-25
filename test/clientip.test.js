"use strict";

/**
 * Rate-limit bucketing must not be attacker-controllable. CF-Connecting-IP is
 * honored only when the immediate peer is a trusted proxy; from any other peer
 * the socket address wins, so rotating the header can't mint fresh buckets.
 */

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { open } = require("../lib/db");
const { createApp, makeClientIp, parseTrustedProxies } = require("../lib/app");

const CSRF = ["X-Requested-With", "XMLHttpRequest"];

/** Minimal req stand-in: a peer address plus headers. */
function fakeReq(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers, ip: headers["x-forwarded-for"] || remoteAddress };
}

test("parseTrustedProxies defaults to loopback and parses a list", () => {
  assert.deepEqual(parseTrustedProxies(""), ["127.0.0.1", "::1"]);
  assert.deepEqual(parseTrustedProxies(undefined), ["127.0.0.1", "::1"]);
  assert.deepEqual(parseTrustedProxies("10.0.0.5, 10.0.0.6"), ["10.0.0.5", "10.0.0.6"]);
});

test("CF-Connecting-IP is honored from a trusted peer", () => {
  const clientIp = makeClientIp(["127.0.0.1", "::1"]);
  assert.equal(clientIp(fakeReq("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" })), "203.0.113.9");
  // IPv4-mapped IPv6 form of loopback still counts as trusted.
  assert.equal(clientIp(fakeReq("::ffff:127.0.0.1", { "cf-connecting-ip": "203.0.113.9" })), "203.0.113.9");
});

test("CF-Connecting-IP is ignored from an untrusted peer", () => {
  const clientIp = makeClientIp(["127.0.0.1", "::1"]);
  // A LAN neighbour or sibling container forging the header gets its own address.
  assert.equal(clientIp(fakeReq("192.168.1.50", { "cf-connecting-ip": "203.0.113.9" })), "192.168.1.50");
  assert.equal(clientIp(fakeReq("192.168.1.50", { "cf-connecting-ip": "1.1.1.1" })), "192.168.1.50");
});

test("a spoofing untrusted peer cannot vary its rate-limit key", () => {
  const clientIp = makeClientIp(["127.0.0.1"]);
  const keys = new Set(
    ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"].map((spoof) =>
      clientIp(fakeReq("192.168.1.50", { "cf-connecting-ip": spoof }))
    )
  );
  assert.equal(keys.size, 1, "all requests from one peer must share a bucket");
  assert.equal([...keys][0], "192.168.1.50");
});

test("only the first address of a CF-Connecting-IP list is used", () => {
  const clientIp = makeClientIp(["127.0.0.1"]);
  assert.equal(clientIp(fakeReq("127.0.0.1", { "cf-connecting-ip": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
});

test("a trusted proxy list can name a remote tunnel host", () => {
  const clientIp = makeClientIp(["10.0.0.5"]);
  assert.equal(clientIp(fakeReq("10.0.0.5", { "cf-connecting-ip": "203.0.113.9" })), "203.0.113.9");
  assert.equal(clientIp(fakeReq("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" })), "127.0.0.1");
});

test("with no trusted peer, header rotation does not extend the auth limit", async () => {
  // Requests arrive from loopback in-process, so trust only a foreign address.
  const store = open(":memory:");
  store.bootstrapAdmin({ username: "admin", password: "password123" });
  const app = createApp({
    store,
    config: { sessionSecret: "test-secret-test-secret-test-sec", trustedProxies: "10.9.9.9" },
  });

  let limited = false;
  // authLimiter allows 10 per window; 12 tries with a different forged header each.
  for (let i = 0; i < 12; i += 1) {
    const res = await request(app)
      .post("/api/admin/login")
      .set(...CSRF)
      .set("CF-Connecting-IP", `203.0.113.${i}`)
      .send({ username: "admin", password: "wrong" });
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, "forged headers must not buy extra login attempts");
});
