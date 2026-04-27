#!/usr/bin/env node
/**
 * Bundle the agent code + assets into dist/agent-bundle/ ready for upload to
 * s3://<bucket>/agent/bundle.zip by CDK's BucketDeployment.
 *
 * Output layout:
 *   dist/agent-bundle/
 *     agent/
 *       bootstrap.js      (esbuild bundle, runs on the EC2 instance)
 *     agents/
 *       prompts/
 *         agent-loop.md   (read at runtime by agentLoop.ts)
 */
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'dist', 'agent-bundle');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'agent'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'agents', 'prompts'), { recursive: true });

const sharedBuildOpts = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  mainFields: ['module', 'main'],
  sourcemap: false,
  logLevel: 'info',
};

esbuild.buildSync({
  ...sharedBuildOpts,
  entryPoints: [path.join(repoRoot, 'agent', 'bootstrap.ts')],
  outfile: path.join(outDir, 'agent', 'bootstrap.js'),
});

esbuild.buildSync({
  ...sharedBuildOpts,
  entryPoints: [path.join(repoRoot, 'agent', 's3Mcp.ts')],
  outfile: path.join(outDir, 'agent', 's3Mcp.js'),
});

// Runtime assets
fs.copyFileSync(
  path.join(repoRoot, 'agents', 'prompts', 'agent-loop.md'),
  path.join(outDir, 'agents', 'prompts', 'agent-loop.md'),
);

console.log(`✅ agent bundle ready → ${outDir}`);
