import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");

function createMutationProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCronAddCommand(program);
  registerCronEditCommand(program);
  return program;
}

const topicMutationCases = [
  {
    operation: "add",
    method: "cron.add",
    args: [
      "add",
      "--name",
      "topic-proof",
      "--every",
      "1m",
      "--agent",
      "main",
      "--message",
      "hello",
      "--channel",
      "telegram",
      "--to",
      "group-123",
    ],
  },
  {
    operation: "edit",
    method: "cron.update",
    args: ["edit", "job-1", "--channel", "telegram", "--to", "group-123"],
  },
] as const;

describe("shared automation mutation options", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("updates an existing automation to an exit-triggered schedule", async () => {
    await createMutationProgram().parseAsync(
      ["edit", "job-1", "--on-exit", "./watch.sh", "--on-exit-cwd", "/repo"],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { schedule: { kind: "on-exit", command: "./watch.sh", cwd: "/repo" } },
    });
  });

  it.each([
    [["--on-exit-cwd", "/repo"], "--on-exit-cwd requires --on-exit"],
    [["--on-exit", "./watch.sh", "--every", "5m"], "Choose at most one schedule change"],
  ])("rejects invalid exit-triggered schedule options", async (args, message) => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      await expect(
        createMutationProgram().parseAsync(["edit", "job-1", ...args], { from: "user" }),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each(
    topicMutationCases.flatMap((mutation) =>
      ["", "   "].map((threadId) => ({
        operation: mutation.operation,
        args: mutation.args,
        threadId,
      })),
    ),
  )(
    "rejects blank thread id $threadId before automation $operation",
    async ({ args, threadId }) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      try {
        await expect(
          createMutationProgram().parseAsync([...args, "--thread-id", threadId], {
            from: "user",
          }),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("--thread-id must be a positive integer"),
        );
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it.each(topicMutationCases)(
    "preserves omitted and maximum-safe topic ids on automation $operation",
    async ({ operation, method, args }) => {
      for (const threadId of [undefined, Number.MAX_SAFE_INTEGER]) {
        callGatewayFromCli.mockClear();
        await createMutationProgram().parseAsync(
          [...args, ...(threadId === undefined ? [] : ["--thread-id", String(threadId)])],
          { from: "user" },
        );
        const call = callGatewayFromCli.mock.calls.find(
          ([calledMethod]) => calledMethod === method,
        );
        const request = call?.[2] as {
          delivery?: { threadId?: number };
          patch?: { delivery?: { threadId?: number } };
        };
        const delivery = operation === "add" ? request.delivery : request.patch?.delivery;
        expect(delivery?.threadId).toBe(threadId);
      }
    },
  );

  it.each(["", "   ", "topic-42"])(
    "rejects invalid thread id %j before loading an automation for a combined edit",
    async (threadId) => {
      const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      try {
        await expect(
          createMutationProgram().parseAsync(
            [
              "edit",
              "job-1",
              "--pacing-min",
              "30m",
              "--channel",
              "telegram",
              "--to",
              "group-123",
              "--thread-id",
              threadId,
            ],
            { from: "user" },
          ),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("--thread-id must be a positive integer"),
        );
        expect(callGatewayFromCli).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it("keeps creation defaults out of automation edit patches", () => {
    const program = createMutationProgram();
    const add = program.commands.find((command) => command.name() === "add")!;
    const edit = program.commands.find((command) => command.name() === "edit")!;
    const creationDefaults: Array<[string, string | boolean]> = [
      ["wake", "now"],
      ["tz", ""],
      ["exact", false],
      ["lightContext", false],
      ["announce", false],
      ["channel", "last"],
      ["bestEffortDeliver", false],
    ];

    for (const [name, value] of creationDefaults) {
      expect(add.getOptionValue(name)).toBe(value);
      expect(edit.getOptionValue(name)).toBeUndefined();
    }
  });
});

describe("automation job policy authoring", () => {
  let existing: CronJob & { configRevision: string };
  const createArgs = [
    "add",
    "--name",
    "policy-proof",
    "--every",
    "30m",
    "--agent",
    "main",
    "--message",
    "Check updates",
  ];

  beforeEach(() => {
    existing = {
      id: "job-1",
      name: "policy-proof",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      configRevision: "policy-revision",
      schedule: { kind: "every", everyMs: 1_800_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Check updates" },
      state: {},
    };
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockImplementation(async (method: string) =>
      method === "cron.get" ? existing : { ok: true },
    );
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  async function rejectMutation(args: string[], message: string) {
    await expect(createMutationProgram().parseAsync(args, { from: "user" })).rejects.toMatchObject({
      name: "ExitError",
      code: 1,
    });
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(
      callGatewayFromCli.mock.calls.filter(
        ([method]) => method === "cron.add" || method === "cron.update",
      ),
    ).toEqual([]);
  }

  it.each([undefined, true, false])(
    "preserves boolean policy presence (%s) on add and edit",
    async (value) => {
      const flags =
        value === undefined
          ? []
          : value
            ? ["--idle-only", "--skip-if-scratch-empty"]
            : ["--no-idle-only", "--no-skip-if-scratch-empty"];
      await createMutationProgram().parseAsync([...createArgs, ...flags], { from: "user" });
      const added = callGatewayFromCli.mock.calls.find(([method]) => method === "cron.add")?.[2];
      expect(added).toMatchObject({ payload: { kind: "agentTurn", message: "Check updates" } });
      if (value === undefined) {
        expect(added).not.toHaveProperty("idleOnly");
        expect(added.payload).not.toHaveProperty("skipIfScratchEmpty");
      } else {
        expect(added).toMatchObject({ idleOnly: value, payload: { skipIfScratchEmpty: value } });
      }
      expect(added).not.toHaveProperty("activeHours");
      expect(added.delivery).not.toHaveProperty("target");
      expect(added.delivery).not.toHaveProperty("directPolicy");

      existing.activeHours = { start: "22:00", end: "06:00", timezone: "local" };
      existing.idleOnly = true;
      existing.payload = { kind: "agentTurn", message: "Check updates", skipIfScratchEmpty: true };
      existing.delivery = { mode: "none", target: "owner", directPolicy: "block" };
      await createMutationProgram().parseAsync(
        ["edit", "job-1", ...(value === undefined ? ["--message", "Updated"] : flags)],
        { from: "user" },
      );
      expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
        id: "job-1",
        ...(value !== undefined ? { expectedConfigRevision: "policy-revision" } : {}),
        patch: {
          ...(value !== undefined ? { idleOnly: value } : {}),
          payload: {
            kind: "agentTurn",
            ...(value === undefined ? { message: "Updated" } : { skipIfScratchEmpty: value }),
          },
        },
      });
    },
  );

  it.each([
    { start: "22:00", end: "06:00", timezone: "America/Los_Angeles" },
    { start: "09:00", end: "24:00", timezone: "local" },
    { start: "00:00", end: "24:00", timezone: "user" },
    { start: "09:00", end: "09:00", timezone: undefined },
  ])("authors a complete $start-$end window in $timezone", async (activeHours) => {
    const flags = [
      "--active-hours-start",
      activeHours.start,
      "--active-hours-end",
      activeHours.end,
      ...(activeHours.timezone ? ["--active-hours-timezone", activeHours.timezone] : []),
    ];
    for (const args of [createArgs, ["edit", "job-1"]]) {
      await createMutationProgram().parseAsync([...args, ...flags], { from: "user" });
    }
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({ activeHours }),
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { activeHours },
      expectedConfigRevision: "policy-revision",
    });
  });

  it.each([
    {
      flags: ["--active-hours-start", "21:00"],
      window: { start: "21:00", end: "06:00", timezone: "Europe/Oslo" },
    },
    {
      flags: ["--active-hours-end", "24:00"],
      window: { start: "22:00", end: "24:00", timezone: "Europe/Oslo" },
    },
    {
      flags: ["--active-hours-timezone", "user"],
      window: { start: "22:00", end: "06:00", timezone: "user" },
    },
  ])("merges $flags against one revision-guarded job snapshot", async ({ flags, window }) => {
    existing.activeHours = { start: "22:00", end: "06:00", timezone: "Europe/Oslo" };
    existing.pacing = { min: "15m", max: "4h" };
    await createMutationProgram().parseAsync(["edit", "job-1", ...flags, "--pacing-min", "30m"], {
      from: "user",
    });
    expect(callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.get")).toHaveLength(
      1,
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { activeHours: window, pacing: { min: "30m", max: "4h" } },
      expectedConfigRevision: "policy-revision",
    });
  });

  it("clears the whole window and nullable policies while explicitly disabling scratch suppression", async () => {
    existing.activeHours = { start: "22:00", end: "06:00", timezone: "local" };
    existing.idleOnly = false;
    existing.delivery = {
      mode: "announce",
      target: "owner",
      directPolicy: "block",
      channel: "telegram",
      accountId: "alerts",
    };
    await createMutationProgram().parseAsync(
      [
        "edit",
        "job-1",
        "--clear-active-hours",
        "--clear-idle-only",
        "--clear-delivery-target",
        "--clear-direct-policy",
        "--no-skip-if-scratch-empty",
      ],
      { from: "user" },
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      expectedConfigRevision: "policy-revision",
      patch: {
        activeHours: null,
        idleOnly: null,
        delivery: { target: null, directPolicy: null },
        payload: { kind: "agentTurn", skipIfScratchEmpty: false },
      },
    });
  });

  it("creates owner delivery without manufacturing a last-chat route", async () => {
    await createMutationProgram().parseAsync(
      [...createArgs, "--delivery-target", "owner", "--direct-policy", "allow"],
      { from: "user" },
    );
    const added = callGatewayFromCli.mock.calls.find(([method]) => method === "cron.add")?.[2];
    expect(added.delivery).toEqual({
      mode: "announce",
      target: "owner",
      directPolicy: "allow",
    });
  });

  it.each(["announce", "none", "webhook"] as const)(
    "switches %s delivery to owner without stale routing or relaxed restrictions",
    async (mode) => {
      existing.delivery = {
        mode,
        to: mode === "webhook" ? "https://example.invalid/hook" : "group-123",
        directPolicy: "block",
        ...(mode !== "webhook" ? { channel: "telegram", accountId: "alerts", threadId: 42 } : {}),
        ...(mode === "announce"
          ? { completionDestination: { mode: "webhook", to: "https://example.invalid/completion" } }
          : {}),
      };
      await createMutationProgram().parseAsync(["edit", "job-1", "--delivery-target", "owner"], {
        from: "user",
      });
      expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
        id: "job-1",
        expectedConfigRevision: "policy-revision",
        patch: {
          delivery: {
            target: "owner",
            to: null,
            threadId: null,
            ...(mode === "webhook" ? { mode: "announce" } : {}),
          },
        },
      });
    },
  );

  it.each([
    {
      flags: ["--to", "group-456", "--thread-id", "7"],
      delivery: { target: null, to: "group-456", threadId: 7 },
    },
    {
      flags: ["--webhook", "https://example.invalid/hook"],
      delivery: { mode: "webhook", target: null, to: "https://example.invalid/hook" },
    },
    { flags: ["--clear-delivery-target"], delivery: { target: null } },
    { flags: ["--direct-policy", "allow"], delivery: { directPolicy: "allow" } },
  ])(
    "edits owner delivery with $flags and leaves unmentioned policy fields alone",
    async ({ flags, delivery }) => {
      existing.delivery = {
        mode: "announce",
        target: "owner",
        channel: "telegram",
        accountId: "alerts",
        directPolicy: "block",
      };
      await createMutationProgram().parseAsync(["edit", "job-1", ...flags], { from: "user" });
      expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
        id: "job-1",
        patch: { delivery },
        expectedConfigRevision: "policy-revision",
      });
    },
  );

  it("does not reinterpret a blank recipient as a switch away from owner delivery", async () => {
    existing.delivery = { mode: "announce", target: "owner", directPolicy: "block" };
    await createMutationProgram().parseAsync(["edit", "job-1", "--to", "  "], { from: "user" });
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      patch: { delivery: { to: undefined } },
    });
  });

  it("preserves explicit owner channel/account constraints on add and edit", async () => {
    const flags = [
      "--delivery-target",
      "owner",
      "--channel",
      "telegram",
      "--account",
      "alerts",
      "--direct-policy",
      "block",
      "--no-deliver",
    ];
    for (const args of [createArgs, ["edit", "job-1"]]) {
      await createMutationProgram().parseAsync([...args, ...flags], { from: "user" });
    }
    const delivery = {
      mode: "none",
      target: "owner",
      channel: "telegram",
      accountId: "alerts",
      directPolicy: "block",
    };
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({ delivery: expect.objectContaining(delivery) }),
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
      id: "job-1",
      expectedConfigRevision: "policy-revision",
      patch: { delivery: { ...delivery, to: null, threadId: null } },
    });
  });

  it.each([
    {
      flags: ["--active-hours-start", "22:00"],
      error: "requires --active-hours-start and --active-hours-end",
    },
    {
      flags: ["--active-hours-timezone", "local"],
      error: "requires --active-hours-start and --active-hours-end",
    },
    { flags: ["--active-hours-start", "24:00", "--active-hours-end", "06:00"], error: "HH:MM" },
    { flags: ["--active-hours-start", "09:00", "--active-hours-end", "24:01"], error: "HH:MM" },
    {
      flags: [
        "--active-hours-start",
        "09:00",
        "--active-hours-end",
        "17:00",
        "--active-hours-timezone",
        "Not/AZone",
      ],
      error: "IANA timezone",
    },
    { flags: ["--delivery-target", "last"], error: "--delivery-target must be owner" },
    { flags: ["--delivery-target", "owner", "--to", "group-123"], error: "cannot be combined" },
    { flags: ["--delivery-target", "owner", "--thread-id", "42"], error: "cannot be combined" },
    {
      flags: ["--delivery-target", "owner", "--webhook", "https://example.invalid/hook"],
      error: "cannot be combined",
    },
    { flags: ["--direct-policy", "deny"], error: "--direct-policy must be allow or block" },
    {
      flags: ["--direct-policy", "block", "--webhook", "https://example.invalid/hook"],
      error: "requires chat delivery",
    },
  ])("rejects invalid policy options $flags before any mutation", async ({ flags, error }) => {
    for (const args of [createArgs, ["edit", "job-1"]]) {
      await rejectMutation([...args, ...flags], error);
    }
  });

  it.each([
    ["--active-hours-start", "09:00", "--clear-active-hours"],
    ["--active-hours-end", "17:00", "--clear-active-hours"],
    ["--active-hours-timezone", "local", "--clear-active-hours"],
    ["--idle-only", "--clear-idle-only"],
    ["--no-idle-only", "--clear-idle-only"],
    ["--delivery-target", "owner", "--clear-delivery-target"],
    ["--direct-policy", "block", "--clear-direct-policy"],
  ])("rejects contradictory set/clear options %j", async (...flags) => {
    await rejectMutation(["edit", "job-1", ...flags], "not both");
  });

  it.each(["--skip-if-scratch-empty", "--no-skip-if-scratch-empty"])(
    "rejects %s on non-agent payloads without changing the job kind",
    async (flag) => {
      await rejectMutation(
        ["add", "--name", "command", "--every", "30m", "--command", "echo ok", flag],
        "require --message",
      );
      existing.payload = { kind: "command", argv: ["echo", "ok"] };
      await rejectMutation(["edit", "job-1", flag], "require an agentTurn job");
      await rejectMutation(
        ["edit", "job-1", "--command", "echo ok", flag],
        "Choose at most one payload change",
      );
    },
  );

  it.each(["--delivery-target", "--direct-policy"])(
    "rejects %s on a stored main-session job",
    async (flag) => {
      existing.sessionTarget = "main";
      existing.payload = { kind: "systemEvent", text: "Check" };
      await rejectMutation(
        ["edit", "job-1", flag, flag === "--delivery-target" ? "owner" : "block"],
        "require a non-main job",
      );
      existing.sessionTarget = "isolated";
      await rejectMutation(
        [
          "edit",
          "job-1",
          "--session",
          " MAIN ",
          flag,
          flag === "--delivery-target" ? "owner" : "block",
        ],
        "require a non-main job",
      );
    },
  );

  it("does not claim to apply a chat restriction to a stored webhook job", async () => {
    existing.delivery = { mode: "webhook", to: "https://example.invalid/hook" };
    await rejectMutation(["edit", "job-1", "--direct-policy", "block"], "requires chat delivery");
  });
});
