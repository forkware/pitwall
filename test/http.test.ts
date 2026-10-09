import { describe, expect, it } from "vitest";
import { startHttp } from "../src/server/http.ts";
import { testCore } from "./helpers.ts";

describe("http", () => {
  it("requires the token, then a cookie", async () => {
    const core = await testCore();
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "secret", built: true });
    try {
      const base = `http://127.0.0.1:${http.port}`;
      expect((await fetch(`${base}/api/state`)).status).toBe(401);
      expect((await fetch(`${base}/?token=wrong`, { redirect: "manual" })).status).toBe(401);

      const login = await fetch(`${base}/?token=secret`, { redirect: "manual" });
      expect(login.status).toBe(302);
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const state = await fetch(`${base}/api/state`, { headers: { cookie } });
      expect(state.status).toBe(200);
      expect((await state.json()).app.name).toBe("pitwall");
    } finally {
      await http.close();
    }
  });

  it("says whether the server code on disk changed since the start", async () => {
    const core = await testCore();
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    try {
      const res = await fetch(`http://127.0.0.1:${http.port}/api/code`, { headers: { authorization: "Bearer t" } });
      expect(await res.json()).toEqual({ stale: false });
    } finally {
      await http.close();
    }
  });

  it("returns user errors as 400 with a message", async () => {
    const core = await testCore();
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    try {
      const res = await fetch(`http://127.0.0.1:${http.port}/api/folders`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ name: "" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/empty/);
    } finally {
      await http.close();
    }
  });
});
