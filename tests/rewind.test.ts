import { describe, expect, it } from "vitest";

import { keepMessages, mintUlid, newSessionId, rewriteExport } from "../adapter/rewind.mjs";

/** The same shape `kilo export` returns — two turns, parent-linked. */
const fixture = (): any => ({
  info: {
    id: "ses_source",
    slug: "fixture-session",
    projectID: "global",
    directory: "/mnt/c/Users/Admin",
    path: "mnt/c/Users/Admin",
    title: "fixture",
  },
  messages: [
    {
      info: { id: "msg_u1", sessionID: "ses_source", role: "user" },
      parts: [{ type: "text", text: "first instruction", id: "prt_u1", sessionID: "ses_source", messageID: "msg_u1" }],
    },
    {
      info: { id: "msg_a1", sessionID: "ses_source", parentID: "msg_u1", role: "assistant" },
      parts: [{ type: "text", text: "first reply", id: "prt_a1", sessionID: "ses_source", messageID: "msg_a1" }],
    },
    {
      info: { id: "msg_u2", sessionID: "ses_source", parentID: "msg_a1", role: "user" },
      parts: [{ type: "text", text: "second instruction", id: "prt_u2", sessionID: "ses_source", messageID: "msg_u2" }],
    },
    {
      info: { id: "msg_a2", sessionID: "ses_source", parentID: "msg_u2", role: "assistant" },
      parts: [{ type: "text", text: "second reply", id: "prt_a2", sessionID: "ses_source", messageID: "msg_a2" }],
    },
  ],
});

describe("mintUlid / newSessionId", () => {
  it("mints Kilo-shaped, collision-free ids", () => {
    const a = mintUlid();
    const b = mintUlid();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(a).not.toBe(b);
    expect(newSessionId()).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/u);
  });
});

describe("keepMessages", () => {
  it("keeps everything up to the end of the requested turn", () => {
    const { messages } = fixture();
    expect(keepMessages(messages, 1)).toHaveLength(2);
    expect(keepMessages(messages, 1)[0].info.id).toBe("msg_u1");
    expect(keepMessages(messages, 2)).toHaveLength(4);
    expect(keepMessages(messages, 2)).toBe(messages); // whole transcript — same object
  });

  it("never cuts more than the transcript holds", () => {
    const { messages } = fixture();
    // A checkpoint can only come from this store, so overshooting must not
    // drop retained history: the list passes through untouched.
    expect(keepMessages(messages, 9)).toBe(messages);
  });

  it("cuts from the first user message when asked for turn zero, keeping any preamble", () => {
    const messages = [
      { info: { id: "m_sys", role: "system" }, parts: [] },
      { info: { id: "m_u1", role: "user" }, parts: [] },
      { info: { id: "m_a1", role: "user" }, parts: [] }, // tool results are not role:user in Kilo
    ];
    const kept = keepMessages(messages, 0);
    expect(kept.map((m: any) => m.info.id)).toEqual(["m_sys"]);
    expect(keepMessages(messages, 0)[0].info.id).toBe("m_sys");
  });
});

describe("rewriteExport", () => {
  it("truncates to the checkpoint's turn and roots the clone in the target directory", () => {
    const rewritten = rewriteExport(fixture(), { truncateTo: 1, directory: "/workspace/new" });
    expect(rewritten.messages).toHaveLength(2);
    expect(rewritten.messages.map((m: any) => m.info.role)).toEqual(["user", "assistant"]);
    expect(rewritten.info.directory).toBe("/workspace/new");
    expect(rewritten.info.path).toBe("workspace/new"); // Kilo stores it without the leading slash
  });

  it("mints a fresh session id and points every reference at it", () => {
    const rewritten = rewriteExport(fixture(), { truncateTo: 2 });
    const sid = rewritten.info.id;
    expect(sid).toMatch(/^ses_/u);
    expect(sid).not.toBe("ses_source");

    for (const message of rewritten.messages) {
      expect(message.info.sessionID).toBe(sid);
      expect(message.info.id).toMatch(/^msg_/u);
      for (const part of message.parts) {
        expect(part.sessionID).toBe(sid);
        expect(part.messageID).toBe(message.info.id);
        expect(part.id).toMatch(/^prt_/u);
      }
    }
    // Original ids are gone, so `kilo import` cannot collide with the source.
    const ids = rewritten.messages.map((m: any) => m.info.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("msg_u1");
    expect(ids).not.toContain("msg_a1");
  });

  it("rewrites the parentID chain onto the new ids", () => {
    const rewritten = rewriteExport(fixture(), { truncateTo: 2, newSessionId: "ses_clone" });
    expect(rewritten.info.id).toBe("ses_clone");
    const [first, second] = rewritten.messages;
    expect(first.info.parentID).toBeUndefined(); // root stays root
    expect(second.info.parentID).toBe(first.info.id); // chain intact
  });

  it("drops a parent that is not part of the kept transcript instead of leaving it dangling", () => {
    const exported = fixture();
    exported.messages[0].info.parentID = "msg_ghost"; // a parent outside the export
    const rewritten = rewriteExport(exported, { truncateTo: 2 });
    expect(rewritten.messages[0].info.parentID).toBeUndefined();
  });

  it("keeps the whole transcript when no truncation point is given", () => {
    const rewritten = rewriteExport(fixture(), {});
    expect(rewritten.messages).toHaveLength(4);
  });
});
