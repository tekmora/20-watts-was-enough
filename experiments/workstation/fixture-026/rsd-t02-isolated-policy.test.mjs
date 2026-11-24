import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HOST_LOAD_PER_CPU_LIMIT, testWithHostDeadline } from "../../../scripts/lib/host-test-deadline.mjs";
import { canonicalize, sha256Hex } from "../lib/checkpoint-ledger.mjs";
import {
  FIXTURE_026_RSD_T02_ACTIVE_ARM_IDS,
  buildFixture026RsdT02SystemPacket,
  evaluateFixture026RsdT02ArmBase,
  runFixture026RsdT02Arm,
  validateFixture026RsdT02ArmBankConfig,
} from "./rsd-t02-arm-bank.mjs";
import { FIXTURE_026_RSD_T02_RECIPES } from "./rsd-t02-contract.mjs";
import {
  buildFixture026RsdT02EpisodeCommand,
  buildFixture026RsdT02WorkUnits,
  fixture026RsdT02Projection,
  generateFixture026RsdT02Transcript,
} from "./rsd-t02-generator.mjs";
import {
  FIXTURE_026_RSD_T02_ISOLATED_RESPONSE_VERSION,
  classifyFixture026RsdT02PolicyChildResult,
  loadFixture026RsdT02PolicyBundleInventory,
  runFixture026RsdT02IsolatedPolicyPacket,
} from "./rsd-t02-isolated-policy.mjs";

const SEED = "1561001";
// 2026-11-23, 32 CPUs, load 31–36: children took 744–1514 ms alone. At load 36
// the five-packet test took 15.2 s, mostly computing expected arms in the parent.
// Beside a pre-push gate, the slowest of three samples took 6758 ms (memory PSI
// full avg10 12.24). The failing shard took 16.66 s to report abstention without
// a reason; its 1 ms timeout test took 9059 ms versus 327 ms alone. The child's
// duration beyond the 15 s kill is unknown. Allow twice that lower bound for a
// transient stall; use the three-sample median so one stall cannot inflate the
// persistent slowdown term. Its margin of six follows dcd8a0bf.
const CHILD_SAMPLES = 3;
const CHILD_MARGIN = 6;
const STALL_ALLOWANCE_MS = 30_000;
const PLANTED_STALL_MS = 17_000;
const RESULT_TEST_TIMEOUT_MS = 300_000;
// Match OUTPUT_LOCK_IO_TIMEOUT_MS in workstation/lib/output-lock.mjs for temporary filesystem work.
const TEMP_IO_TIMEOUT_MS = 30_000;
const FIXTURE_ROOT = "experiments/workstation/fixture-026";
const CONFIG_PATH = path.join(FIXTURE_ROOT, "configs", "rsd-t02-arm-bank.json");
const units = buildFixture026RsdT02WorkUnits({ profile: "smoke", seeds: [SEED] });
const packets = new Map();
let childProcessAvailable;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// After exit, only the pipes can delay close, so give them one bounded drain allowance.
function probeDeadlineAction({ exitCode, signalCode, draining }) {
  if (exitCode === null && signalCode === null) return "kill";
  return draining ? "expire" : "drain";
}

function classifyProbeClose({ code, signal, timedOut, stdout }) {
  if (timedOut) {
    throw new Error(`UNDECIDED: host starved; child-process probe exceeded ${STALL_ALLOWANCE_MS} ms`);
  }
  if (signal !== null) {
    throw new Error(`child-process probe terminated by ${signal} before its ${STALL_ALLOWANCE_MS} ms deadline`);
  }
  return code === 0 && stdout === "fixture-026-child-probe";
}

test("probe close distinguishes its own deadline from an external kill", () => {
  const success = { code: 0, signal: null, timedOut: false, stdout: "fixture-026-child-probe" };
  assert.equal(classifyProbeClose(success), true);
  assert.equal(classifyProbeClose({ ...success, code: 1 }), false);
  assert.equal(classifyProbeClose({ ...success, stdout: "unexpected" }), false);
  assert.throws(() => classifyProbeClose({ ...success, code: null, signal: "SIGKILL" }), {
    message: `child-process probe terminated by SIGKILL before its ${STALL_ALLOWANCE_MS} ms deadline`,
  });
  for (const signal of [null, "SIGKILL"]) {
    assert.throws(() => classifyProbeClose({ ...success, signal, timedOut: true }), {
      message: `UNDECIDED: host starved; child-process probe exceeded ${STALL_ALLOWANCE_MS} ms`,
    });
  }
});

test("probe deadline kills a running child and bounds the pipe drain of an exited one", () => {
  assert.equal(probeDeadlineAction({ exitCode: null, signalCode: null, draining: false }), "kill");
  assert.equal(probeDeadlineAction({ exitCode: 0, signalCode: null, draining: false }), "drain");
  assert.equal(probeDeadlineAction({ exitCode: null, signalCode: "SIGTERM", draining: false }), "drain");
  assert.equal(probeDeadlineAction({ exitCode: 0, signalCode: null, draining: true }), "expire");
});

async function canCreateChildProcess() {
  if (childProcessAvailable !== undefined) return childProcessAvailable;
  const close = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [
        "--permission", "--input-type=module", "--eval",
        "process.stdout.write('fixture-026-child-probe')",
      ], {
        env: {}, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(null);
      return;
    }
    let timedOut = false;
    let draining = false;
    function onDeadline() {
      const action = probeDeadlineAction({ exitCode: child.exitCode, signalCode: child.signalCode, draining });
      if (action === "drain") {
        draining = true;
        timer = setTimeout(onDeadline, STALL_ALLOWANCE_MS);
        return;
      }
      timedOut = true;
      if (action === "kill") {
        child.kill("SIGKILL");
      } else {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }
    let timer = setTimeout(onDeadline, STALL_ALLOWANCE_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
  childProcessAvailable = close !== null && classifyProbeClose(close);
  return childProcessAvailable;
}

async function policyInputs() {
  const policyConfigUtf8 = await readFile(CONFIG_PATH, "utf8");
  return {
    policyConfigUtf8,
    config: validateFixture026RsdT02ArmBankConfig(JSON.parse(policyConfigUtf8)),
    inventory: await loadFixture026RsdT02PolicyBundleInventory(),
  };
}

function packetFor(recipeId) {
  if (!packets.has(recipeId)) {
    const projections = units.filter((unit) => unit.recipe_id === recipeId).map((unit) => (
      fixture026RsdT02Projection(
        generateFixture026RsdT02Transcript(buildFixture026RsdT02EpisodeCommand(unit)),
      )
    ));
    packets.set(recipeId, buildFixture026RsdT02SystemPacket(projections).packet);
  }
  return packets.get(recipeId);
}

function successfulChildResponse(baseResults, overrides = {}) {
  return {
    schema: 1,
    contract_version: FIXTURE_026_RSD_T02_ISOLATED_RESPONSE_VERSION,
    status: "completed",
    arm_outcomes: FIXTURE_026_RSD_T02_ACTIVE_ARM_IDS.map((armId, index) => ({
      arm_id: armId,
      status: "completed",
      arm_result: baseResults[index],
      reason_codes: [],
    })),
    reason_codes: [],
    active_arm_ids: FIXTURE_026_RSD_T02_ACTIVE_ARM_IDS,
    request_sha256: "1".repeat(64),
    request_bytes: 1,
    packet_sha256: "2".repeat(64),
    packet_utf8_bytes: 1,
    config_sha256: "3".repeat(64),
    config_utf8_bytes: 1,
    bundle_sha256: "4".repeat(64),
    runtime: {
      node_version: process.versions.node,
      v8_version: process.versions.v8,
      platform: process.platform,
      architecture: process.arch,
      numeric_model: "IEEE-754-binary64",
    },
    authority: "public-development-policy-base-v2-only",
    comparison_inference_permitted: false,
    claim_eligible: false,
    result_label: "NO_RESULT",
    no_result: true,
    ...overrides,
  };
}

function childResult(response = null, overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdoutExceeded: false,
    stderrExceeded: false,
    spawnError: false,
    stdout: Buffer.from(response === null ? "" : `${canonicalize(response)}\n`, "utf8"),
    stderr: Buffer.alloc(0),
    ...overrides,
  };
}

test("the checked-in policy bundle and source inventory are closed and content addressed", async () => {
  const inventory = await loadFixture026RsdT02PolicyBundleInventory();
  assert.equal(path.basename(inventory.bundle_path), `${inventory.bundle_sha256}.js`);
  assert.equal(sha256(await readFile(inventory.bundle_path)), inventory.bundle_sha256);
  assert.equal(
    sha256Hex(canonicalize(inventory.document.sources)),
    inventory.source_inventory_sha256,
  );
  const inventoryBytes = await readFile(inventory.inventory_path);
  assert.equal(inventoryBytes[0] === 0xef && inventoryBytes[1] === 0xbb, false);
  assert.equal(inventoryBytes.includes(0x0d), false);
  assert.equal(inventoryBytes.at(-1), 0x0a);
  const bundleText = await readFile(inventory.bundle_path, "utf8");
  assert.doesNotMatch(bundleText, /\bimport\s|\brequire\s*\(|node:/u);
});

function hostStarved({ reasonCodes, loadPerCpu }) {
  return reasonCodes.includes("isolated-policy-timeout") && loadPerCpu > HOST_LOAD_PER_CPU_LIMIT;
}

function abstentionMessage({
  phase, recipeId, status, reasonCodes, elapsedMs, deadlineMs, baselineMs, loadPerCpu, starved,
}) {
  const prefix = starved ? "UNDECIDED: host starved; " : "";
  const reasons = [...new Set(reasonCodes)].sort().join(",");
  return `${prefix}phase=${phase} recipeId=${recipeId} status=${status} reasonCodes=${reasons} `
    + `elapsedMs=${elapsedMs} deadlineMs=${deadlineMs} baselineMs=${baselineMs} `
    + `loadPerCpu=${loadPerCpu} starved=${starved}`;
}

function hostLoadPerCpu() {
  return os.loadavg()[0] / os.availableParallelism();
}

async function timedChild(options) {
  const startLoadPerCpu = hostLoadPerCpu();
  const start = performance.now();
  const isolated = await runFixture026RsdT02IsolatedPolicyPacket(options);
  return { isolated, elapsedMs: performance.now() - start, startLoadPerCpu };
}

function requireCompleted(
  { isolated, elapsedMs, startLoadPerCpu },
  { phase, recipeId, deadlineMs, baselineMs },
  endLoadPerCpu = hostLoadPerCpu(),
) {
  if (isolated.status === "completed") return isolated;
  const reasonCodes = isolated.active_arm_outcomes.flatMap((arm) => arm.reason_codes);
  const loadPerCpu = Math.max(startLoadPerCpu, endLoadPerCpu);
  // A calibration child that needs the whole stall allowance is starved at any
  // load; a crash or malformed response stays a plain failure in both phases.
  const starved = phase === "calibration"
    ? reasonCodes.includes("isolated-policy-timeout")
    : hostStarved({ reasonCodes, loadPerCpu });
  assert.fail(abstentionMessage({
    phase, recipeId, status: isolated.status, reasonCodes, elapsedMs: Math.ceil(elapsedMs),
    deadlineMs, baselineMs, loadPerCpu, starved,
  }));
}

async function childBaseline({ config, policyConfigUtf8 }, packet) {
  const samples = [];
  for (let index = 0; index < CHILD_SAMPLES; index += 1) {
    const run = await timedChild({ packet, config, policyConfigUtf8, timeoutMs: STALL_ALLOWANCE_MS });
    requireCompleted(run, {
      phase: "calibration", recipeId: FIXTURE_026_RSD_T02_RECIPES[0].recipe_id,
      deadlineMs: STALL_ALLOWANCE_MS, baselineMs: "unavailable",
    });
    samples.push(run.elapsedMs);
  }
  return {
    baselineMs: Math.ceil(samples.toSorted((a, b) => a - b)[Math.floor(CHILD_SAMPLES / 2)]),
    samplesMs: samples.map(Math.ceil),
  };
}

function derivedChildDeadline({ baselineMs, spentMs, packetCount }) {
  const deadlineMs = Math.ceil(baselineMs * CHILD_MARGIN) + STALL_ALLOWANCE_MS;
  return { deadlineMs, decidable: spentMs + packetCount * deadlineMs < RESULT_TEST_TIMEOUT_MS };
}

function childDeadlineMs(t, { baselineMs, samplesMs }, packetCount, start) {
  const spentMs = performance.now() - start;
  const { deadlineMs, decidable } = derivedChildDeadline({ baselineMs, spentMs, packetCount });
  if (!decidable) {
    assert.fail(`UNDECIDED: host starved; measured baseline ${baselineMs} ms; deadline ${deadlineMs} ms; test bound ${RESULT_TEST_TIMEOUT_MS} ms`);
  }
  t.diagnostic(`isolated child samples ${samplesMs.join(",")} ms; baseline ${baselineMs} ms; deadline ${deadlineMs} ms`);
  return deadlineMs;
}

test("only an isolated policy timeout above the host load limit indicates starvation", () => {
  const reasonCodes = ["isolated-policy-timeout"];
  assert.equal(hostStarved({ reasonCodes, loadPerCpu: 3 }), true);
  assert.equal(hostStarved({ reasonCodes, loadPerCpu: 1 }), false);
  assert.equal(hostStarved({ reasonCodes, loadPerCpu: HOST_LOAD_PER_CPU_LIMIT }), false);
  assert.equal(hostStarved({ reasonCodes: ["isolated-policy-child-crash"], loadPerCpu: 3 }), false);
});

test("abstention diagnostics identify the packet, sorted reasons, timing and host load", () => {
  const failure = {
    phase: "result", recipeId: "M-I1-FFL", status: "abstained",
    reasonCodes: ["isolated-policy-timeout", "isolated-policy-bank-incomplete", "isolated-policy-timeout"],
    elapsedMs: 36_011, deadlineMs: 36_000, baselineMs: 1000, loadPerCpu: 3,
  };
  const fields = "phase=result recipeId=M-I1-FFL status=abstained "
    + "reasonCodes=isolated-policy-bank-incomplete,isolated-policy-timeout "
    + "elapsedMs=36011 deadlineMs=36000 baselineMs=1000 loadPerCpu=3";
  assert.equal(abstentionMessage({ ...failure, starved: false }), `${fields} starved=false`);
  assert.equal(abstentionMessage({ ...failure, starved: true }), `UNDECIDED: host starved; ${fields} starved=true`);
});

test("only a calibration timeout reports starvation; a calibration crash fails plainly", () => {
  const run = (reasonCode) => ({
    isolated: { status: "abstained", active_arm_outcomes: [{ reason_codes: [reasonCode] }] },
    elapsedMs: 10, startLoadPerCpu: 1,
  });
  const where = { phase: "calibration", recipeId: "M-I1-FFL", deadlineMs: STALL_ALLOWANCE_MS, baselineMs: "unavailable" };
  assert.throws(() => requireCompleted(run("isolated-policy-child-crash"), where),
    (error) => !error.message.startsWith("UNDECIDED") && error.message.endsWith("starved=false"));
  assert.throws(() => requireCompleted(run("isolated-policy-timeout"), where),
    { message: /^UNDECIDED: host starved; phase=calibration .* starved=true$/u });
});

test("result timeouts use the higher load at child start or completion", () => {
  const isolated = { status: "abstained", active_arm_outcomes: [{ reason_codes: ["isolated-policy-timeout"] }] };
  const where = { phase: "result", recipeId: "M-I1-FFL", deadlineMs: 36_000, baselineMs: 1000 };
  const run = { isolated, elapsedMs: 36_011, startLoadPerCpu: 1 };
  assert.throws(() => requireCompleted({ ...run, startLoadPerCpu: 3 }, where, 1),
    { message: /^UNDECIDED: host starved; phase=result .* loadPerCpu=3 starved=true$/u });
  assert.throws(() => requireCompleted(run, where, 3),
    { message: /^UNDECIDED: host starved; phase=result .* loadPerCpu=3 starved=true$/u });
  assert.throws(() => requireCompleted(run, where, 1),
    { message: /^phase=result .* loadPerCpu=1 starved=false$/u });
});

test("derived child deadline requires room below the result test bound", () => {
  assert.deepEqual(derivedChildDeadline({ baselineMs: 1000, spentMs: 3000, packetCount: 5 }), {
    deadlineMs: 36_000, decidable: true,
  });
  const boundary = { baselineMs: 4500, spentMs: 15_000, packetCount: 5 };
  assert.deepEqual(derivedChildDeadline(boundary), { deadlineMs: 57_000, decidable: false });
  assert.equal(derivedChildDeadline({ ...boundary, spentMs: 14_999 }).decidable, true);
});

async function resultChild(packet, { config, policyConfigUtf8 }, recipeId, deadlineMs, baselineMs) {
  const run = await timedChild({ packet, config, policyConfigUtf8, timeoutMs: deadlineMs });
  return requireCompleted(run, { phase: "result", recipeId, deadlineMs, baselineMs });
}

function expectedResponses(packet, { config, policyConfigUtf8, inventory }) {
  return FIXTURE_026_RSD_T02_ACTIVE_ARM_IDS.map((armId) => runFixture026RsdT02Arm({
    armId,
    packet,
    config,
    policyArtifactSha256: inventory.bundle_sha256,
    policyArtifactBytes: inventory.bundle_bytes,
    policyConfigSha256: sha256(Buffer.from(policyConfigUtf8, "utf8")),
    policyConfigBytes: Buffer.byteLength(policyConfigUtf8, "utf8"),
  }));
}

testWithHostDeadline("all five packets preserve nine-arm base-v2 results across the fresh isolated child", {
  timeout: RESULT_TEST_TIMEOUT_MS,
}, async (context) => {
  const start = performance.now();
  if (!(await canCreateChildProcess())) {
    context.skip("host sandbox denies child-process creation; run outside that sandbox");
    return;
  }
  const inputs = await policyInputs();
  const { inventory, policyConfigUtf8 } = inputs;
  const configSha256 = sha256(Buffer.from(policyConfigUtf8, "utf8"));
  const cases = FIXTURE_026_RSD_T02_RECIPES.map(({ recipe_id: recipeId }) => {
    const packet = packetFor(recipeId);
    return {
      recipeId, packet, responses: expectedResponses(packet, inputs),
      packetSha256: sha256(Buffer.from(canonicalize(packet), "utf8")),
    };
  });
  const calibration = await childBaseline(inputs, cases[0].packet);
  const deadlineMs = childDeadlineMs(context, calibration, cases.length, start);
  for (const { recipeId, packet, responses, packetSha256 } of cases) {
    const isolated = await resultChild(packet, inputs, recipeId, deadlineMs, calibration.baselineMs);
    assert.deepEqual(isolated.active_arm_outcomes, []);
    assert.equal(isolated.receipt.execution_mode, "fresh-node-child-hardened-vm");
    assert.equal(isolated.receipt.bundle_sha256, inventory.bundle_sha256);
    assert.equal(isolated.receipt.hash_attachment, "parent-after-validated-child-return");
    for (const field of [
      "filesystem_exposed_to_policy", "network_exposed_to_policy",
      "environment_exposed_to_policy", "clock_exposed_to_policy",
      "random_exposed_to_policy", "evaluator_exposed_to_policy",
      "dynamic_code_generation_exposed_to_policy",
    ]) assert.equal(isolated.receipt[field], false, field);
    assert.deepEqual(isolated.responses, responses);
    for (const response of isolated.responses) {
      assert.equal(response.policy_artifact_sha256, inventory.bundle_sha256);
      assert.equal(response.policy_config_sha256, configSha256);
      assert.equal(response.system_packet_sha256, packetSha256);
    }
  }
});

test("base-v2 policy output contains no hashes for the parent to trust prematurely", async () => {
  const { config } = await policyInputs();
  const base = evaluateFixture026RsdT02ArmBase({
    armId: "B-STATE-SPACE",
    packet: packetFor("M-I1-FFL"),
    config,
  });
  assert.deepEqual(Object.keys(base), [
    "schema", "contract_version", "arm_id", "properties", "counter",
    "retained_scalars", "parameter_scalars",
  ]);
  assert.equal(canonicalize(base).includes("sha256"), false);
});

test("timeout becomes an ordered visible bank abstention with no fallback", {
  timeout: 30_000,
}, async (context) => {
  if (!(await canCreateChildProcess())) {
    context.skip("host sandbox denies child-process creation; run outside that sandbox");
    return;
  }
  const { config, policyConfigUtf8 } = await policyInputs();
  const outcome = await runFixture026RsdT02IsolatedPolicyPacket({
    packet: packetFor("M-I1-FFL"),
    config,
    policyConfigUtf8,
    timeoutMs: 1,
  });
  assert.equal(outcome.status, "abstained");
  assert.equal(outcome.responses, null);
  assert.deepEqual(
    outcome.active_arm_outcomes.map((row) => row.arm_id),
    FIXTURE_026_RSD_T02_ACTIVE_ARM_IDS,
  );
  for (const row of outcome.active_arm_outcomes) {
    assert.deepEqual(row.reason_codes, ["isolated-policy-timeout"]);
    assert.equal(row.action, "abstain");
    assert.equal(row.retry_invocations, 0);
    assert.equal(row.fallback_invocations, 0);
    assert.equal(row.result_label, "NO_RESULT");
  }
});

test("crash, malformed, output overflow, replay, and work overflow classify fail closed", async () => {
  const { config, inventory } = await policyInputs();
  const packet = packetFor("M-I1-FFL");
  const bases = FIXTURE_026_RSD_T02_ACTIVE_ARM_IDS.map((armId) => (
    evaluateFixture026RsdT02ArmBase({ armId, packet, config })
  ));
  assert.equal(classifyFixture026RsdT02PolicyChildResult(childResult(null, {
    timedOut: true,
  })).reason, "isolated-policy-timeout");
  assert.equal(classifyFixture026RsdT02PolicyChildResult(childResult(null, {
    exitCode: 9,
  })).reason, "isolated-policy-child-crash");
  assert.equal(classifyFixture026RsdT02PolicyChildResult(childResult(null, {
    stdoutExceeded: true,
  })).reason, "isolated-policy-protocol-over-budget");
  assert.equal(classifyFixture026RsdT02PolicyChildResult(childResult(null, {
    stdout: Buffer.from("{}\n{}\n", "utf8"),
  })).reason, "isolated-policy-malformed-response");

  const overBudgetBases = structuredClone(bases);
  overBudgetBases[0].counter.scalar_operations += 1;
  assert.equal(classifyFixture026RsdT02PolicyChildResult(childResult(
    successfulChildResponse(overBudgetBases),
  )).reason, "isolated-policy-work-over-budget");

  const requestBytes = Buffer.from("request", "utf8");
  const packetBytes = Buffer.from("packet", "utf8");
  const configBytes = Buffer.from("config", "utf8");
  const binding = {
    request_sha256: sha256(requestBytes),
    request_bytes: requestBytes.length,
    packet_sha256: sha256(packetBytes),
    packet_utf8_bytes: packetBytes.length,
    config_sha256: sha256(configBytes),
    config_utf8_bytes: configBytes.length,
    bundle_sha256: inventory.bundle_sha256,
  };
  const valid = successfulChildResponse(bases, binding);
  assert.equal(classifyFixture026RsdT02PolicyChildResult(childResult(valid), {
    requestBytes, packetBytes, configBytes, inventory,
  }).reason, undefined);
  const replayed = structuredClone(valid);
  replayed.packet_sha256 = "f".repeat(64);
  assert.equal(classifyFixture026RsdT02PolicyChildResult(childResult(replayed), {
    requestBytes, packetBytes, configBytes, inventory,
  }).reason, "isolated-policy-malformed-response");
});

async function boundedIo(operation, label, timeoutMs = TEMP_IO_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      operation(AbortSignal.timeout(timeoutMs)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`temporary I/O deadline: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withTemporaryDirectory(prefix, run, remove = rm) {
  const directory = await boundedIo(() => mkdtemp(prefix), "create temporary directory");
  let completed = false;
  try {
    await run(directory);
    completed = true;
  } finally {
    await boundedIo(() => remove(directory, { recursive: true, force: true }), "remove temporary directory")
      .catch((error) => {
        if (completed) throw error;
      });
  }
}

async function wrapperExecutable(filePath) {
  try {
    await boundedIo(() => access(filePath, constants.X_OK), "check wrapper execute permission");
    return true;
  } catch (error) {
    if (error.code === "EACCES") return false;
    throw error;
  }
}

test("wrapper execution requires execute permission", { skip: process.platform === "win32" }, async (context) => {
  // Checkout tmp/ may also be mounted noexec, so the 0644 result is meaningful only if the 0755 control passes.
  const parent = path.resolve("tmp");
  await boundedIo(() => mkdir(parent, { recursive: true }), "create checkout tmp directory");
  await withTemporaryDirectory(path.join(parent, "fixture-026-mode-"), async (directory) => {
    const control = path.join(directory, "755");
    await boundedIo((signal) => writeFile(control, "", { mode: 0o755, signal }), "write executable control");
    if (!(await wrapperExecutable(control))) {
      context.skip("checkout tmp/ does not permit execution (noexec); execute-permission control unavailable");
      return;
    }
    const filePath = path.join(directory, "644");
    await boundedIo((signal) => writeFile(filePath, "", { mode: 0o644, signal }), "write mode fixture");
    assert.equal(await wrapperExecutable(filePath), false);
    await assert.rejects(wrapperExecutable(path.join(directory, "missing")), { code: "ENOENT" });
  });
});

test("temporary I/O deadline identifies the stalled operation", { timeout: 5000 }, async () => {
  await assert.rejects(boundedIo(() => new Promise(() => {}), "planted stall", 50),
    { message: "temporary I/O deadline: planted stall" });
});

test("temporary cleanup reports its own failure unless the test already failed", async () => {
  const prefix = path.join(os.tmpdir(), "fixture-026-cleanup-");
  const cleanupError = new Error("planted cleanup failure");
  const testError = new Error("planted test failure");
  const removeThenFail = async (directory, options) => {
    await rm(directory, options);
    throw cleanupError;
  };
  await assert.rejects(withTemporaryDirectory(prefix, () => {}, removeThenFail),
    (error) => error === cleanupError);
  await assert.rejects(withTemporaryDirectory(prefix, () => { throw testError; }, removeThenFail),
    (error) => error === testError);
});

testWithHostDeadline("a fresh child stalled past the production deadline completes under the derived deadline", {
  timeout: RESULT_TEST_TIMEOUT_MS,
}, async (context) => {
  const start = performance.now();
  if (process.platform === "win32") return context.skip("slow-node requires POSIX shebang execution");
  if (!(await canCreateChildProcess())) return context.skip("host sandbox denies child-process creation");
  if (typeof process.execve !== "function") return context.skip("slow-node requires process.execve");
  const realNode = process.execPath;
  const shebang = `#!${realNode}`;
  if (Buffer.byteLength(shebang) > 255) return context.skip("slow-node shebang exceeds 255 bytes");
  if (/\s/u.test(realNode)) return context.skip("slow-node shebang cannot carry whitespace in the node path");

  await withTemporaryDirectory(path.resolve(os.tmpdir(), "fixture-026-stall-"), async (directory) => {
    const wrapper = path.join(directory, "slow-node");
    const nodeLiteral = JSON.stringify(realNode);
    const script = `${shebang}\n`
      + `setTimeout(() => process.execve(${nodeLiteral}, [${nodeLiteral}, ...process.argv.slice(2)], {}), ${PLANTED_STALL_MS});\n`;
    await boundedIo((signal) => writeFile(wrapper, script, { mode: 0o755, signal }), "write stalled child wrapper");
    if (!(await wrapperExecutable(wrapper))) {
      return context.skip("temporary directory does not permit execution (noexec); planted stall needs an executable wrapper");
    }
    const inputs = await policyInputs();
    const recipeId = FIXTURE_026_RSD_T02_RECIPES[0].recipe_id;
    const packet = packetFor(recipeId);
    const responses = expectedResponses(packet, inputs);
    const calibration = await childBaseline(inputs, packet);
    const deadlineMs = childDeadlineMs(context, calibration, 1, start);
    assert.ok(deadlineMs > PLANTED_STALL_MS + 2 * calibration.baselineMs);
    const { config, policyConfigUtf8 } = inputs;
    process.execPath = wrapper;
    try {
      const [control, isolated] = await Promise.all([
        runFixture026RsdT02IsolatedPolicyPacket({ packet, config, policyConfigUtf8 }),
        resultChild(packet, inputs, recipeId, deadlineMs, calibration.baselineMs),
      ]);
      assert.equal(control.status, "abstained");
      assert.deepEqual(control.active_arm_outcomes.map((row) => row.reason_codes),
        FIXTURE_026_RSD_T02_ACTIVE_ARM_IDS.map(() => ["isolated-policy-timeout"]));
      assert.deepEqual(isolated.responses, responses);
      assert.equal(isolated.receipt.execution_mode, "fresh-node-child-hardened-vm");
    } finally {
      process.execPath = realNode;
    }
  });
  assert.equal(process.execPath, realNode);
});
