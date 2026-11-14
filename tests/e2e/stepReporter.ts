import { writeFileSync } from "node:fs";
import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

// TEMPORARY (spec 072): for each test over 6 s, its top-level API and expect steps over 300 ms, so CI shows where a test spends its time; reverted before merge.
export default class StepReporter implements Reporter {
  private out: Record<string, { ms: number; steps: [string, number, number][] }> = {};
  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.duration < 6000) return;
    const t0 = result.startTime.getTime();
    const steps: [string, number, number][] = [];
    const walk = (s: TestStep) => {
      if (s.duration >= 300 && (s.category === "pw:api" || s.category === "expect" || s.category === "hook" || s.category === "fixture")) {
        steps.push([`${s.location ? `${s.location.file.split("/").pop()}:${s.location.line} ` : ""}${s.title}`.slice(0, 120), s.startTime.getTime() - t0, s.duration]);
      }
      if (s.category !== "pw:api" && s.category !== "expect") s.steps.forEach(walk);
    };
    result.steps.forEach(walk);
    this.out[`${test.location.file.split("/").pop()}:${test.location.line} ${test.title.slice(0, 60)}`] = { ms: result.duration, steps };
  }
  onEnd(): void { writeFileSync(process.env.STEP_REPORT ?? "steps.json", JSON.stringify(this.out, null, 1)); }
}
