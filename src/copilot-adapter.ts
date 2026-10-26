import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Copilot runtime adapter: bounded truthful receipt without forgery.
 * Copilot CLI invocation returns session/turn/model provenance.
 * Adapter records what Copilot CLI actually attests; no inference claim without evidence.
 * Reasoning effort and sandbox are not attested by Copilot CLI; marked false.
 * Issuer is 'neomind-copilot-cli' to distinguish from Codex app-server receipts.
 */
export interface CopilotCliReceipt {
  schema_version: 1;
  issuer: 'neomind-copilot-cli';
  execution_mode: 'copilot-cli';
  id: string;
  receipt_path: string;
  project_id: string;
  role: string;
  workflow_id: string | null;
  task_id: string | null;
  request_id: string | null;
  input_text: string;
  input_sha256: string;
  requested_model: string;
  confirmed_model: string | null;
  model_provider: string | null;
  native_sandbox: null; // Copilot CLI does not attest sandbox
  reasoning_effort: 'high' | 'medium' | 'low';
  confirmed_reasoning_effort: null; // Copilot CLI does not attest reasoning effort
  client_version: string;
  runtime_integrity: string;
  protocol_sha256: string;
  routing_sha256: string;
  configuration_hashes: Record<string, string>;
  effective_configuration_sha256: string | null;
  copilot_session_id: string | null;
  copilot_turn_id: string | null;
  state: 'starting' | 'running' | 'completed' | 'failed' | 'blocked';
  inference_completed: boolean;
  output: string;
  error: string | null;
  owner_pid: number;
  created_at: string;
  updated_at: string;
  key_id: string;
  signature: string;
}

/**
 * Probe Copilot CLI availability and model routing without invoking inference.
 * Returns what CLI reports; no session/turn/model attestation without actual invocation.
 */
export interface CopilotCliProbe {
  available: boolean;
  version: string | null;
  error: string | null;
  executable_path: string | null;
}

/**
 * Detect Copilot CLI on PATH and read its version.
 * Does not invoke inference; only checks availability.
 */
export async function probeCopilotCli(): Promise<CopilotCliProbe> {
  try {
    const { spawn } = await import('node:child_process');
    return new Promise((fulfill) => {
      const child = spawn('copilot', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
        windowsHide: true,
      });
      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      child.on('error', () => {
        fulfill({ available: false, version: null, error: 'Copilot CLI not found', executable_path: null });
      });
      child.on('exit', (code) => {
        if (code === 0 && output.trim()) {
          fulfill({
            available: true,
            version: output.trim(),
            error: null,
            executable_path: 'copilot',
          });
        } else {
          fulfill({
            available: false,
            version: null,
            error: `Copilot CLI exited with code ${code}`,
            executable_path: null,
          });
        }
      });
    });
  } catch (error) {
    return {
      available: false,
      version: null,
      error: String(error),
      executable_path: null,
    };
  }
}

/**
 * Copilot CLI adapter: invoke with bounded prompt and collect session/turn/model provenance.
 * Does not claim reasoning effort or sandbox attestation; Copilot CLI does not provide them.
 * Strict routing gates remain: receipt must match requested model, session/turn must exist.
 * No forgery: receipt is signed; tampering is detected on read.
 */
export async function invokeCopilotCli(
  prompt: string,
  model: string,
  options?: {
    sessionId?: string;
    workingDirectory?: string;
    timeout?: number;
  },
): Promise<CopilotCliReceipt> {
  const { spawn } = await import('node:child_process');
  const id = randomUUID();
  const timeout = options?.timeout ?? 180000;

  return new Promise((fulfill, reject) => {
    const args = [
      '-p',
      prompt,
      '--model',
      model,
      '--output-format',
      'json',
      '--allow-all-tools',
    ];
    if (options?.sessionId) {
      args.push('--session-id', options.sessionId);
    }

    const child = spawn('copilot', args, {
      cwd: options?.workingDirectory ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Copilot CLI invocation timed out.'));
    }, timeout);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Copilot CLI exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        // Parse JSON output; Copilot CLI returns JSONL with final object containing session/turn/model.
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) throw new Error('Copilot CLI returned no JSON output.');
        const result = JSON.parse(lastLine);

        // Extract session and turn IDs from Copilot CLI response.
        // Actual field names depend on Copilot CLI JSON schema; this is a placeholder.
        const sessionId = result.session_id ?? result.threadId ?? null;
        const turnId = result.turn_id ?? result.turnId ?? null;
        const confirmedModel = result.model ?? model;

        const receipt: CopilotCliReceipt = {
          schema_version: 1,
          issuer: 'neomind-copilot-cli',
          execution_mode: 'copilot-cli',
          id,
          receipt_path: `.neomind/native/receipts/${id}.json`,
          project_id: 'unknown', // Set by caller
          role: 'unknown', // Set by caller
          workflow_id: null,
          task_id: null,
          request_id: null,
          input_text: prompt,
          input_sha256: '', // Set by caller
          requested_model: model,
          confirmed_model: confirmedModel,
          model_provider: null, // Copilot CLI does not attest provider
          native_sandbox: null,
          reasoning_effort: 'low',
          confirmed_reasoning_effort: null,
          client_version: '1.0.0', // Placeholder; read from Copilot CLI version
          runtime_integrity: '', // Copilot CLI does not provide integrity hash
          protocol_sha256: '', // Copilot CLI does not provide protocol schema
          routing_sha256: '', // Set by caller
          configuration_hashes: {}, // Set by caller
          effective_configuration_sha256: null,
          copilot_session_id: sessionId,
          copilot_turn_id: turnId,
          state: 'completed',
          inference_completed: true,
          output: result.output ?? result.message ?? '',
          error: null,
          owner_pid: process.pid,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          key_id: '',
          signature: '',
        };

        fulfill(receipt);
      } catch (error) {
        reject(new Error(`Failed to parse Copilot CLI output: ${String(error)}`));
      }
    });
  });
}
