// Test-only acceptance against the unmodified, pinned Qwen npm/Desktop backend.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [cliArgument, archive, sourceDirectory] = process.argv.slice(2);
const cli = resolve(cliArgument);
const packageRoot = dirname(cli);
const host = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(host.version, '0.25.0', 'This native acceptance check is pinned to Qwen 0.25.0');
assert.ok(process.env.QWEN_HOME && process.env.QWEN_RUNTIME_DIR, 'Run only with isolated Qwen directories');
await mkdir(process.env.QWEN_HOME, { recursive: true });
await writeFile(join(process.env.QWEN_HOME, 'settings.json'), JSON.stringify({
    privacy: { usageStatisticsEnabled: false }, telemetry: { enabled: false },
}));

execFileSync(process.execPath, [cli, 'extensions', 'install', archive, '--consent'], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30_000,
});

// Qwen ships these backend exports in a hashed chunk, not a stable import path.
// Inspect only the export declaration to find the unmodified pinned module.
let backend;
for (const name of await readdir(join(packageRoot, 'chunks'))) {
    if (!name.endsWith('.js')) continue;
    const path = join(packageRoot, 'chunks', name);
    const source = await readFile(path, 'utf8');
    if ([...source.matchAll(/export\s*\{([^}]+)\}/g)].some(match => /\bHookRunner\b/.test(match[1]) && /\bExtensionManager\b/.test(match[1]))) {
        backend = await import(pathToFileURL(path).href);
        break;
    }
}
assert.ok(backend?.HookRunner && backend?.ExtensionManager, 'Cannot find the pinned Qwen backend exports');
const manager = new backend.ExtensionManager({ workspaceDir: process.cwd(), isWorkspaceTrusted: true,
    requestConsent: async () => {}, usageStatisticsEnabled: false });
await manager.refreshCache();
const extension = await manager.loadExtensionByName('e-comet-qwen-preview');
assert.ok(extension, 'Qwen must load the extension it installed from the archive');
assert.match(extension.path, / /, 'Native installation must exercise paths with spaces');
const manifest = JSON.parse(await readFile(join(extension.path, 'qwen-extension.json'), 'utf8'));
assert.equal(extension.config.version, manifest.version);
const hook = extension.hooks.PostToolUse[0].hooks[0];
assert.equal(hook.shell, process.platform === 'win32' ? 'powershell' : undefined);
const token = 'https://example.invalid/browser-job#native-package-check';
const result = await new backend.HookRunner().executeHook(hook, 'PostToolUse', {
    hook_event_name: 'PostToolUse', session_id: 'native-package-session', prompt_id: 'native-package-session########1',
    cwd: process.cwd(), tool_name: 'mcp__e-comet__browser_job', tool_input: { job: { type: 'product_card' } },
    tool_response: { llmContent: [{ text: JSON.stringify({ trigger_url: token }) }] },
});
assert.equal(result.success, true, result.stderr || result.error?.message);
assert.equal(result.exitCode, 0);
assert.doesNotMatch((result.stdout || '') + (result.stderr || ''), /native-package-check/);
const { prepareBrowserCall } = await import(pathToFileURL(join(extension.path, 'qwen/browser-job-proxy.mjs')).href);
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'wb_product_card', arguments: { articles: [123] },
    _meta: { 'qwen-code/invocation': { version: 1, sessionId: 'native-package-session' } },
} };
const prepared = await prepareBrowserCall(call);
assert.equal(prepared.message?.params.arguments.triggerUrl, token);
assert.equal((await prepareBrowserCall(call)).response.result.isError, true);
const feedbackHook = extension.hooks.PreToolUse[0].hooks[0];
const transcriptPath = join(process.cwd(), 'synthetic history not opened.jsonl');
const feedbackArguments = { kind: 'bug', summary: 'Synthetic package hook check',
    details: 'Only path attestation is checked; no history is read or feedback sent.', includeTranscript: true };
const feedbackResult = await new backend.HookRunner().executeHook(feedbackHook, 'PreToolUse', {
    hook_event_name: 'PreToolUse', session_id: 'native-feedback-session', prompt_id: 'native-feedback-session########1',
    cwd: process.cwd(), tool_name: 'mcp__e-comet-local__prepare_e_comet_feedback',
    tool_input: feedbackArguments, transcript_path: transcriptPath,
});
assert.equal(feedbackResult.success, true, feedbackResult.stderr || feedbackResult.error?.message);
assert.equal(feedbackResult.exitCode, 0);
const feedbackPrepared = await prepareBrowserCall({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'prepare_e_comet_feedback', arguments: feedbackArguments,
    _meta: { 'qwen-code/invocation': { version: 1, sessionId: 'native-feedback-session' } },
} });
assert.equal(feedbackPrepared.message?.params.arguments.transcriptPath, transcriptPath);
assert.equal(typeof feedbackPrepared.message.params.arguments.feedbackClaim, 'string');
assert.equal(feedbackArguments.transcriptPath, undefined);
const sourceInstall = spawnSync(process.execPath, [cli, 'extensions', 'install', sourceDirectory, '--consent'], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30_000,
});
assert.equal(sourceInstall.error, undefined);
assert.equal(sourceInstall.status, 1, 'Qwen must reject the build source instead of installing an OS-mismatched manifest');
assert.equal((await manager.loadExtensionByName('e-comet-qwen-preview')).config.version, manifest.version);
console.log(JSON.stringify({ host: `Qwen ${host.version}`, platform: process.platform,
    installedVersion: manifest.version, archiveInstall: true, nativeHookRunner: true, oneUseClaim: true,
    nativeFeedbackHook: true, sourceFallbackRejected: true }));
