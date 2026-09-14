import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function attachRecoveryInput(error, recoveryInput) {
  if (error && typeof error === 'object') error.recoveryInput = recoveryInput;
  return error;
}

function materializeStdin() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-capture-stdin-'));
  try {
    fs.chmodSync(directory, 0o700);
    const inputPath = path.join(directory, 'input.json');
    fs.writeFileSync(inputPath, fs.readFileSync(0), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(inputPath, 0o600);
    return { directory, inputPath };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    const captureError = new Error(`Unable to materialize standard input: ${error instanceof Error ? error.message : String(error)}`);
    captureError.code = 'CAPTURE_INPUT_INVALID';
    throw captureError;
  }
}

/** Adapt direct input into the existing path-only capture authority. */
export async function captureWithInputTransport(options, capture) {
  if (options.inputPath !== '-') return capture(options);

  const transport = materializeStdin();
  try {
    const result = await capture({ ...options, inputPath: transport.inputPath });
    fs.rmSync(transport.directory, { recursive: true, force: true });
    const { recoveryInput, ...response } = result;
    return response;
  } catch (error) {
    throw attachRecoveryInput(error, transport.inputPath);
  }
}
