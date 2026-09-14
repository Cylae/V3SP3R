import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyTtsEcho, getWakeGreeting, broadcast } from "./index";
import { WebSocket } from "ws";

test("isLikelyTtsEcho detects exact and partial speech echoes", () => {
  const spoken = "Scanning sub gigahertz frequencies now";

  // Exact match
  assert.strictEqual(isLikelyTtsEcho("Scanning sub gigahertz frequencies now", spoken), true);

  // Substring match
  assert.strictEqual(isLikelyTtsEcho("sub gigahertz frequencies", spoken), true);

  // High word overlap
  assert.strictEqual(isLikelyTtsEcho("Scanning sub gigahertz frequencies please", spoken), true);

  // Completely unrelated input should NOT be detected as echo
  assert.strictEqual(isLikelyTtsEcho("Open garage door", spoken), false);

  // Empty input should not crash or trigger echo
  assert.strictEqual(isLikelyTtsEcho("", spoken), false);
  assert.strictEqual(isLikelyTtsEcho("some text", ""), false);
});

test("getWakeGreeting returns valid context-aware greeting strings", () => {
  const commandGreeting = getWakeGreeting(true);
  assert.strictEqual(typeof commandGreeting, "string");
  assert.ok(commandGreeting.length > 0);

  const initialGreeting = getWakeGreeting(false);
  assert.strictEqual(typeof initialGreeting, "string");
  assert.ok(initialGreeting.length > 0);
});

test("broadcast forwards messages to open WebSockets", () => {
  let sentData: string | null = null;
  const mockWs = {
    readyState: WebSocket.OPEN,
    send: (payload: string) => {
      sentData = payload;
    },
  } as unknown as WebSocket;

  broadcast([mockWs], {
    type: "STATUS_UPDATE",
    text: "Unit Test Broadcast",
  });

  assert.ok(sentData !== null);
  const parsed = JSON.parse(sentData!);
  assert.strictEqual(parsed.type, "STATUS_UPDATE");
  assert.strictEqual(parsed.text, "Unit Test Broadcast");
});
