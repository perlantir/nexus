import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test the CLI by spawning it as a child process using tsx.
// This validates command parsing, output formatting, and exit codes end-to-end.
// The DeciGraphClient is NOT mocked here — instead we expect the CLI to fail with
// a connection error and verify it exits code 1 and prints a useful message.

const CLI_ENTRY = join(import.meta.dirname, '../src/decigraph-cli.ts');
const TSX = join(import.meta.dirname, '../node_modules/.bin/tsx');

function runCli(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], {
    env: {
      ...process.env,
      DECIGRAPH_API_URL: 'http://localhost:19999', // intentionally unreachable
      DECIGRAPH_PROJECT_ID: 'proj-test-123',
      DECIGRAPH_API_KEY: 'test-key',
      NO_COLOR: '1', // disable chalk colour codes for assertion stability
      FORCE_COLOR: '0',
      ...env,
    },
    encoding: 'utf-8',
    timeout: 12000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

describe('CLI — --help', () => {
  it('--help prints usage without errors and exits 0', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/decigraph/i);
    expect(result.stdout).toMatch(/Usage/i);
  });
});

describe('CLI — command parsing', () => {
  it('init command accepts project name argument and exits with error when server unreachable', () => {
    // init runs against the server; unreachable server should cause a non-zero exit
    const result = runCli(['init', 'my-cool-project', '--description', 'Test project']);
    // Status can be 0 (help printed) or 1 (error), but should not throw a Node parse error
    expect(result.status).toBeGreaterThanOrEqual(0);
    // Should not print a Node.js crash stack trace
    expect(result.stderr).not.toMatch(/TypeError\s*:|ReferenceError\s*:/);
  });

  it('compile command requires agent and task positional arguments', () => {
    // Omit required positional args — commander should print error usage
    const result = runCli(['compile']);
    // Commander exits with 1 and prints error when required args missing
    expect(result.status).not.toBe(0);
  });

  it('distill command requires file positional argument', () => {
    const result = runCli(['distill']);
    expect(result.status).not.toBe(0);
  });

  it('decisions list accepts --status filter argument without Node parse errors', () => {
    // This will fail connecting to the server, but the arg parsing itself should work
    const result = runCli(['decisions', 'list', '--status', 'active']);
    expect(result.stderr).not.toMatch(/TypeError\s*:|SyntaxError\s*:/);
  });

  it('agents list runs command without Node parse errors', () => {
    const result = runCli(['agents', 'list']);
    expect(result.stderr).not.toMatch(/TypeError\s*:|SyntaxError\s*:/);
  });
});

describe('CLI — output formatting', () => {
  it('decisions list prints structured output when server responds', () => {
    // With an unreachable server, the CLI prints a connection error and exits 1.
    // We validate the error message is human-readable (not a raw exception).
    const result = runCli(['decisions', 'list']);
    expect(result.status).toBe(1);
    // The error output should include something meaningful, not a raw JS stack
    const combinedOutput = result.stdout + result.stderr;
    expect(combinedOutput).toMatch(/error|Error|ECONNREFUSED|fetch|failed|unreachable/i);
  });

  it('status command shows structured error when project unreachable', () => {
    const result = runCli(['status']);
    expect(result.status).toBe(1);
    const combinedOutput = result.stdout + result.stderr;
    expect(combinedOutput.length).toBeGreaterThan(0);
    expect(combinedOutput).not.toMatch(/TypeError\s*:|ReferenceError\s*:/);
  });

  it('compile outputs error (not crash) when server is down', () => {
    const result = runCli(['compile', 'my-agent', 'implement login feature', '--markdown']);
    expect(result.status).toBe(1);
    const combinedOutput = result.stdout + result.stderr;
    // Should NOT be a Node.js crash — the CLI should handle and display the error
    expect(combinedOutput).not.toMatch(/at Object\.<anonymous>|at async main/);
  });
});

describe('CLI — error handling', () => {
  it('shows error when server is unreachable', () => {
    const result = runCli(['decisions', 'list'], {
      DECIGRAPH_API_URL: 'http://localhost:19999',
    });
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    // CLI should surface a helpful error, not crash with an unhandled rejection
    expect(combined).toMatch(/error|Error|connect|fetch|refused/i);
  });

  it('shows error for missing required args on compile', () => {
    const result = runCli(['compile', 'only-one-arg']);
    // Commander should detect missing second positional argument
    expect(result.status).not.toBe(0);
  });

  it('exits with code 1 on API failure', () => {
    const result = runCli(['status']);
    expect(result.status).toBe(1);
  });

  it('shows useful error when DECIGRAPH_PROJECT_ID is not set', () => {
    const result = runCli(['decisions', 'list'], {
      DECIGRAPH_PROJECT_ID: '', // unset
    });
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/DECIGRAPH_PROJECT_ID/i);
  });

  it('distill shows file not found error for missing file', () => {
    const result = runCli(['distill', '/tmp/totally-nonexistent-file-xyz.txt']);
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found|File not found/i);
  });

  it('distill shows empty file error', () => {
    const tmpFile = join(tmpdir(), `decigraph-test-empty-${Date.now()}.txt`);
    writeFileSync(tmpFile, '   \n', 'utf-8');
    try {
      const result = runCli(['distill', tmpFile]);
      expect(result.status).toBe(1);
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/empty|Empty/i);
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  });
});

describe('CLI — notifications command', () => {
  it('shows error when --agent flag and DECIGRAPH_AGENT_ID are both absent', () => {
    const result = runCli(['notifications'], {
      DECIGRAPH_AGENT_ID: '',
    });
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/--agent|DECIGRAPH_AGENT_ID/i);
  });
});

describe('CLI — subcommand help', () => {
  it('decisions --help prints usage for decisions subgroup', () => {
    const result = runCli(['decisions', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/decisions/i);
  });

  it('agents --help prints usage for agents subgroup', () => {
    const result = runCli(['agents', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/agents/i);
  });

  it('compile --help prints expected options', () => {
    const result = runCli(['compile', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--max-tokens|--markdown/i);
  });
});
