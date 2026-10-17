import assert from "node:assert";
import test from "node:test";
import { MentraAdapter, GenericGlassesAdapter } from "./glasses-adapter";
import { broadcast } from "./index";

test("MentraAdapter initializes with correct platform name", () => {
  const adapter = new MentraAdapter("ws://localhost:8089");
  assert.strictEqual(adapter.name, "MentraOS");
});

test("GenericGlassesAdapter initializes with correct platform name", () => {
  const adapter = new GenericGlassesAdapter("ws://localhost:8089");
  assert.strictEqual(adapter.name, "Generic");
});

test("broadcast ignores closed or non-open sockets", () => {
  let sendCount = 0;
  const mockWs = {
    readyState: 0, // CONNECTING
    send: () => { sendCount++; }
  } as any;

  broadcast([mockWs], { type: "STATUS_UPDATE", text: "test" });
  assert.strictEqual(sendCount, 0);
});

test("MentraAdapter initSession registers event handlers without error", () => {
  const adapter = new MentraAdapter("ws://localhost:8089");
  let transcriptionCb: any = null;
  let photoCb: any = null;
  let buttonCb: any = null;

  const mockSession = {
    events: {
      onTranscription: (cb: any) => { transcriptionCb = cb; },
      onPhotoTaken: (cb: any) => { photoCb = cb; },
      onButtonPress: (cb: any) => { buttonCb = cb; }
    }
  };

  adapter.initSession(mockSession);
  assert.ok(transcriptionCb, "onTranscription registered");
  assert.ok(photoCb, "onPhotoTaken registered");
  assert.ok(buttonCb, "onButtonPress registered");
});
