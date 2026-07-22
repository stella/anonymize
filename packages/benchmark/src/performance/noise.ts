import { readFileSync } from "node:fs";

export type CpuNoiseSnapshot = {
  readonly userTicks: number;
  readonly niceTicks: number;
  readonly systemTicks: number;
  readonly idleTicks: number;
  readonly ioWaitTicks: number;
  readonly irqTicks: number;
  readonly softIrqTicks: number;
  readonly stealTicks: number;
};

export type CpuNoiseDelta = CpuNoiseSnapshot & {
  readonly status: "clean" | "kernel-noise-observed";
};

const parseTicks = (value: string, context: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || `${parsed}` !== value) {
    throw new Error(`${context} is not a non-negative integer`);
  }
  return parsed;
};

export const readCpuNoiseSnapshot = (cpu: number): CpuNoiseSnapshot => {
  const prefix = `cpu${cpu} `;
  const line = readFileSync("/proc/stat", "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`Linux CPU ${cpu} counters are unavailable`);
  }
  const fields = line.trim().split(/\s+/u).slice(1, 9);
  if (fields.length !== 8) {
    throw new Error(`Linux CPU ${cpu} counters are incomplete`);
  }
  const ticks = fields.map((value, index) =>
    parseTicks(value, `Linux CPU ${cpu} counter ${index}`),
  );
  return {
    userTicks: ticks.at(0) ?? 0,
    niceTicks: ticks.at(1) ?? 0,
    systemTicks: ticks.at(2) ?? 0,
    idleTicks: ticks.at(3) ?? 0,
    ioWaitTicks: ticks.at(4) ?? 0,
    irqTicks: ticks.at(5) ?? 0,
    softIrqTicks: ticks.at(6) ?? 0,
    stealTicks: ticks.at(7) ?? 0,
  };
};

export const cpuNoiseDelta = (
  before: CpuNoiseSnapshot,
  after: CpuNoiseSnapshot,
): CpuNoiseDelta => {
  const delta = {
    userTicks: after.userTicks - before.userTicks,
    niceTicks: after.niceTicks - before.niceTicks,
    systemTicks: after.systemTicks - before.systemTicks,
    idleTicks: after.idleTicks - before.idleTicks,
    ioWaitTicks: after.ioWaitTicks - before.ioWaitTicks,
    irqTicks: after.irqTicks - before.irqTicks,
    softIrqTicks: after.softIrqTicks - before.softIrqTicks,
    stealTicks: after.stealTicks - before.stealTicks,
  };
  if (Object.values(delta).some((value) => value < 0)) {
    throw new Error("Linux CPU counters moved backwards during measurement");
  }
  return {
    ...delta,
    status:
      delta.irqTicks === 0 && delta.softIrqTicks === 0 && delta.stealTicks === 0
        ? "clean"
        : "kernel-noise-observed",
  };
};

export const assertNoCpuSteal = (delta: CpuNoiseDelta): void => {
  if (delta.stealTicks !== 0) {
    throw new Error("canonical performance CPU accumulated steal time");
  }
};
