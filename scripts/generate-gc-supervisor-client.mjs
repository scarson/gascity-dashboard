import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checkOnly = process.argv.includes('--check');
const schemaPath = path.resolve('backend/openapi/gc-supervisor.openapi.json');
const outputPath = path.resolve('backend/src/generated/gc-supervisor.ts');
const cliPath = path.resolve('node_modules/openapi-typescript/bin/cli.js');
const header = [
  '/* eslint-disable */',
  '// Generated from backend/openapi/gc-supervisor.openapi.json. Do not edit.',
  '',
].join('\n');

async function generate(toPath) {
  const result = spawnSync(
    process.execPath,
    [cliPath, schemaPath, '--output', toPath, '--export-type'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`openapi-typescript failed with exit code ${result.status ?? 'unknown'}`);
  }
  const generated = await readFile(toPath, 'utf8');
  await writeFile(
    toPath,
    generated.startsWith(header) ? generated : `${header}${generated}`,
    'utf8',
  );
}

if (checkOnly) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gc-supervisor-openapi-'));
  const tmpPath = path.join(tmpDir, 'gc-supervisor.ts');
  try {
    await generate(tmpPath);
    const [expected, actual] = await Promise.all([
      readFile(tmpPath, 'utf8'),
      readFile(outputPath, 'utf8'),
    ]);
    if (expected !== actual) {
      throw new Error(
        'backend/src/generated/gc-supervisor.ts is out of date. Run npm run openapi:gc-supervisor:generate.',
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  console.log('generated gc supervisor client is up to date');
} else {
  await generate(outputPath);
  console.log(`generated ${path.relative(process.cwd(), outputPath)}`);
}
