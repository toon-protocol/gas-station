// The gate, run DETERMINISTICALLY by the runner, not asked of the agent.
//
// An agent that is told "do not commit until the gate passes" reports on itself.
// Verifying a build is plumbing, so the runner runs the gate and a red one never
// becomes a PR. This is the same reason `git push` is run by the runner.
//
// The steps are the commands of ci.yml's `build` job, in the same order, so passing
// here means the same thing as passing there. CI runs build, typecheck, lint and test
// concurrently; they are independent of each other, so running them one after another
// here gives the same verdict, and stops at the first failure with its output.
//
// One CI step is left out on purpose: `src/gate-regression-guard.ts`, which compares the
// job's wall-clock against a baseline captured on a GitHub runner. A sandbox's wall-clock
// says nothing about that baseline. CI still runs it on the PR.
//
// This repository has no path-based gates: every file it holds is either app source, a
// test, or the deploy bundle that `deploy/*.test.ts` guards, and vitest runs all of them.

import type * as sandcastle from '@ai-hero/sandcastle';

type Sandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;

export interface GateStep {
  readonly name: string;
  readonly command: string;
}

export interface GateFailure {
  readonly step: string;
  readonly command: string;
  readonly exitCode: number;
  /** Tail of combined output — enough for an agent to act on, bounded so it cannot blow a prompt. */
  readonly output: string;
}

export interface GateResult {
  readonly passed: boolean;
  readonly ran: readonly string[];
  readonly failure: GateFailure | null;
}

/** Keep fed-back output useful but bounded — a full build log is long. */
const MAX_OUTPUT_CHARS = 12_000;

/** The steps of ci.yml's `build` job, in order. Keep in step with that file. */
export const GATE_STEPS: readonly GateStep[] = [
  { name: 'pnpm install', command: 'pnpm install --frozen-lockfile' },
  { name: 'pnpm build', command: 'pnpm build' },
  { name: 'pnpm typecheck', command: 'pnpm typecheck' },
  { name: 'pnpm lint', command: 'pnpm lint' },
  { name: 'pnpm test', command: 'pnpm test' },
];

/**
 * Run `steps` in order, stopping at the first failure.
 *
 * Failure is returned, not thrown, so the caller can decide between a fix
 * iteration and failing the job.
 */
export async function runGate(sandbox: Sandbox, steps: readonly GateStep[]): Promise<GateResult> {
  const ran: string[] = [];

  for (const step of steps) {
    console.log(`  [gate] ${step.name}: ${step.command}`);
    const lines: string[] = [];
    const result = await sandbox.exec(step.command, {
      onLine: (line) => {
        lines.push(line);
        // Stream sparingly: full build output would bury the runner log.
        if (lines.length <= 40) console.log(`    | ${line}`);
      },
    });
    ran.push(step.name);

    if (result.exitCode !== 0) {
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const output =
        combined.length > MAX_OUTPUT_CHARS
          ? `...(truncated to the last ${MAX_OUTPUT_CHARS} chars)...\n` +
            combined.slice(-MAX_OUTPUT_CHARS)
          : combined;

      console.log(`  [gate] FAILED at ${step.name} (exit ${result.exitCode}).`);
      return {
        passed: false,
        ran,
        failure: { step: step.name, command: step.command, exitCode: result.exitCode, output },
      };
    }
  }

  console.log(`  [gate] PASSED (${ran.length} step(s): ${ran.join(', ') || 'none applicable'}).`);
  return { passed: true, ran, failure: null };
}

/** The prompt handed to a fix iteration. Concrete failure, no room to reinterpret the task. */
export function fixPrompt(failure: GateFailure, attempt: number, maxAttempts: number): string {
  return [
    `The repository gate is RED. This is fix attempt ${attempt} of ${maxAttempts}.`,
    '',
    `Failing step: ${failure.step}`,
    `Command:      ${failure.command}`,
    `Exit code:    ${failure.exitCode}`,
    '',
    'Output:',
    '```',
    failure.output,
    '```',
    '',
    'Fix the cause and commit. Rules:',
    `- Re-run \`${failure.command}\` yourself and confirm it passes before you finish.`,
    '- Fix the code. Do NOT weaken, skip, delete or skip a test, and do not',
    '  loosen a lint to make this pass — if the test is genuinely wrong, say so',
    '  explicitly in the commit message and explain why.',
    '- Change only what this failure requires. Do not refactor beyond it.',
    '- If you cannot fix it, commit nothing and explain what is blocking you.',
  ].join('\n');
}
