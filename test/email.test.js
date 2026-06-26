"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createEmailer } = require("../lib/email");

test("falls back to console logging when no API key is set", async () => {
  const original = console.log;
  console.log = () => {}; // silence the dev log during the test
  try {
    const emailer = createEmailer({ apiKey: "", from: "Test <t@example.com>" });
    assert.equal(emailer.hasProvider, false);

    const result = await emailer.sendEmail({ to: "a@b.com", subject: "Hi", text: "Hello" });
    assert.ok(result.id);
    assert.equal(result.dev, true);
  } finally {
    console.log = original;
  }
});

test("throws when no recipient is provided", async () => {
  const emailer = createEmailer({ apiKey: "" });
  await assert.rejects(() => emailer.sendEmail({ subject: "x", text: "y" }), /recipient/);
});
