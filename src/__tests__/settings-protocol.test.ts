import { describe, expect, it } from "vitest";
import {
  getCodePiSessionDir,
  getCanonicalAgentDir,
} from "../pi-store";
import { buildDashboardData } from "../settings-dashboard";
import type { DashboardData, SettingsMessage, SettingsReply } from "../shared/settings-protocol";

describe("settings dashboard protocol", () => {
  it("describes paths and resource status without credential values", () => {
    const data: DashboardData = buildDashboardData(
      getCanonicalAgentDir(),
      getCodePiSessionDir("/vscode/codepi"),
      {},
      [{ source: "npm:example", scope: "user", installed: true }],
      { settings: true, models: false, auth: true },
    );

    expect(JSON.stringify(data)).not.toContain("sk-");
    expect(JSON.stringify(data)).not.toContain("token");
    expect(data.bundledResources).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "custom-footer", enabled: true })]),
    );
  });

  it("defines only stable dashboard commands", () => {
    const messages: SettingsMessage[] = [
      { command: "settings:get" },
      { command: "settings:setBundledResource", id: "filechanges", enabled: false },
      { command: "settings:openFile", file: "auth" },
      { command: "settings:refresh" },
      { command: "settings:openSessions" },
    ];
    expect(messages).toHaveLength(5);
    const reply: SettingsReply = { command: "settings:saved", ok: true, resource: "filechanges" };
    expect(reply.command).toBe("settings:saved");
  });
});
