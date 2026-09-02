import { describe, expect, it } from "vitest";
import { resolveHeartbeatAgents } from "../commands/doctor-heartbeat-legacy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

describe("resolveHeartbeatAgents", () => {
  const systemOwnedConfig = {
    agents: {
      ownership: "explicit",
      entries: { ops: {}, main: {} },
      defaults: { systemAgent: { agentId: "ops" } },
    },
  } as OpenClawConfig;
  const ownerlessConfig = {
    agents: { ownership: "explicit", entries: { ops: {}, main: {} } },
  } as OpenClawConfig;

  it("enrolls the system agent when ambient heartbeat config is absent", () => {
    expect(resolveHeartbeatAgents(systemOwnedConfig)).toEqual([
      { agentId: "ops", heartbeat: undefined },
    ]);
  });

  it("disables ambient heartbeats when an explicit multi-agent roster has no owner", () => {
    expect(resolveHeartbeatAgents(ownerlessConfig)).toEqual([]);
  });

  it.each([
    { name: "system owner", cfg: systemOwnedConfig, expectedAgentIds: ["ops"] },
    {
      name: "explicit heartbeat owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { heartbeat: { agentId: "ops" } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["ops"],
    },
    {
      name: "legacy default marker",
      cfg: {
        agents: { entries: { main: { default: true }, ops: {} } },
      } as OpenClawConfig,
      expectedAgentIds: ["main"],
    },
    {
      name: "sole agent",
      cfg: { agents: { ownership: "explicit", entries: { solo: {} } } } as OpenClawConfig,
      expectedAgentIds: ["solo"],
    },
    {
      name: "per-agent heartbeat entries",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: { heartbeat: { every: "30m" } } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["ops"],
    },
    {
      name: "per-agent enrollment takes precedence over the default heartbeat owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: { heartbeat: { every: "30m" } } },
          defaults: { heartbeat: { agentId: "main" } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["ops"],
    },
    {
      name: "broadcast heartbeat defaults",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { heartbeat: { every: "30m" } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["main", "ops"],
    },
  ])("enrolls exactly the runnable agents for the $name config", ({ cfg, expectedAgentIds }) => {
    const agents = resolveHeartbeatAgents(cfg);
    expect(agents.map((agent) => agent.agentId)).toEqual(expectedAgentIds);
  });
});
