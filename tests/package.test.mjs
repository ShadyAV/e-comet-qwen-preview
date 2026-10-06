import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const platforms = ['win32', 'linux', 'darwin'];
const archiveName = platform => `${platform}.e-comet-skills.zip`;

async function temporary(t) {
    const directory = await mkdtemp(join(tmpdir(), 'e-comet package with spaces '));
    t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    return directory;
}

function build(output) {
    const builder = join(repository, 'scripts/build_archives.py');
    assert.ok(existsSync(builder), 'The archive builder must exist before this package can be released');
    execFileSync(python, [builder, '--output', output], { encoding: 'utf8', timeout: 30_000 });
}

function extract(archive, destination) {
    execFileSync(python, ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, destination], {
        encoding: 'utf8', timeout: 30_000,
    });
}

async function packageFor(t, platform = process.platform) {
    const directory = await temporary(t);
    const output = join(directory, 'archives');
    build(output);
    const root = join(directory, 'installed extension');
    extract(join(output, archiveName(platform)), root);
    const manifest = JSON.parse(await readFile(join(root, 'qwen-extension.json'), 'utf8'));
    return { directory, root, manifest };
}

async function filesAt(root, prefix = '') {
    const files = {};
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) Object.assign(files, await filesAt(root, relative));
        else files[relative] = createHash('sha256').update(await readFile(join(root, relative))).digest('hex');
    }
    return files;
}

function isolatedEnv(directory) {
    const env = { ...process.env, NODE_ENV: 'test', ECOMET_LOCAL_BRIDGE_PORT: '0',
        HOME: directory, USERPROFILE: directory, LOCALAPPDATA: directory, XDG_DATA_HOME: directory,
        PLUGIN_DATA: join(directory, 'plugin state'), CLAUDE_PLUGIN_DATA: join(directory, 'plugin state'),
        QWEN_HOME: join(directory, 'qwen home'), QWEN_RUNTIME_DIR: join(directory, 'qwen runtime') };
    delete env.NODE_OPTIONS;
    return env;
}

async function run(command, args, { input = '', timeoutMs = 15_000, ...options } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        const timeout = setTimeout(() => { child.kill(); reject(new Error(`Packaged process timed out: ${stderr}`)); }, timeoutMs);
        child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
        child.stdin.on('error', () => {});
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
        child.stdin.end(input);
    });
}

async function startMcp(root, manifest, env) {
    const config = manifest.mcpServers['e-comet-local'];
    const expand = value => value.replaceAll('${extensionPath}', root);
    return new Promise((resolve, reject) => {
        const child = spawn(config.command, config.args.map(expand), {
            cwd: expand(config.cwd), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '', buffered = '', result, failure;
        const timeout = setTimeout(() => { child.kill(); reject(new Error(`MCP initialization timed out: ${stderr}`)); }, 15_000);
        const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
        child.stdin.on('error', () => {});
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdout.on('data', chunk => {
            buffered += chunk;
            while (buffered.includes('\n')) {
                const index = buffered.indexOf('\n');
                const line = buffered.slice(0, index);
                buffered = buffered.slice(index + 1);
                if (!line.trim()) continue;
                try {
                    const message = JSON.parse(line);
                    if (message.id === 1) {
                        assert.equal(message.error, undefined);
                        assert.ok(message.result.serverInfo.version);
                        send({ method: 'notifications/initialized' });
                        send({ id: 2, method: 'tools/list', params: {} });
                    } else if (message.id === 2) {
                        assert.equal(message.error, undefined);
                        result = message.result;
                        child.stdin.end();
                    }
                } catch (error) { failure = error; child.kill(); }
            }
        });
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('close', code => {
            clearTimeout(timeout);
            if (failure) reject(failure);
            else if (code !== 0 || !result) reject(new Error(`Packaged MCP failed (${code}): ${stderr}`));
            else resolve(result);
        });
        send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {},
            clientInfo: { name: 'packaged-runtime-check', version: '1' } } });
    });
}

test('release archives are repeatable and differ only by the Windows hook shell', async t => {
    const directory = await temporary(t);
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    build(first);
    build(second);
    assert.deepEqual((await readdir(first)).sort(), platforms.map(archiveName).sort());
    let sharedFiles;
    let sharedManifest;
    for (const platform of platforms) {
        assert.deepEqual(await readFile(join(first, archiveName(platform))), await readFile(join(second, archiveName(platform))));
        const root = join(directory, platform);
        extract(join(first, archiveName(platform)), root);
        const files = await filesAt(root);
        assert.ok(files['mcp/package.json'], 'MCP startup needs its build metadata');
        assert.ok(files['mcp/DIAGNOSTICS.md'], 'Tool descriptions refer to packaged diagnostics');
        assert.ok(files['qwen/browser-job-post.mjs']);
        assert.ok(files['qwen/browser-job-proxy.mjs']);
        assert.ok(files['skills/e-comet-doctor/SKILL.md']);
        assert.ok(files['skills/e-comet-doctor/references/qwen.md']);
        for (const name of Object.keys(files)) {
            assert.match(name, /^(?:LICENSE|qwen-extension\.json|mcp\/(?:package\.json|DIAGNOSTICS\.md|src\/[^/]+\.mjs)|(?:qwen|hooks)\/[^/]+\.mjs|skills\/e-comet-doctor\/(?:SKILL\.md|references\/(?:claude|codex|qwen)\.md))$/,
                `Unapproved install-archive file: ${name}`);
        }
        const manifest = JSON.parse(await readFile(join(root, 'qwen-extension.json'), 'utf8'));
        for (const definition of Object.values(manifest.hooks).flat()) {
            for (const hook of definition.hooks) {
                if (hook.type !== 'command') continue;
                assert.equal(hook.shell, platform === 'win32' ? 'powershell' : undefined);
                delete hook.shell;
            }
        }
        delete files['qwen-extension.json'];
        if (sharedFiles) {
            assert.deepEqual(files, sharedFiles);
            assert.deepEqual(manifest, sharedManifest);
        } else { sharedFiles = files; sharedManifest = manifest; }
    }
});

test('every command hook receives its platform shell, including additional lifecycle events', async t => {
    const directory = await temporary(t);
    const source = join(directory, 'source');
    await mkdir(join(source, 'packaging'), { recursive: true });
    for (const name of ['LICENSE', 'qwen', 'hooks', 'mcp', 'skills']) {
        await cp(join(repository, name), join(source, name), { recursive: true });
    }
    const manifest = JSON.parse(await readFile(join(repository, 'packaging/qwen-extension.json'), 'utf8'));
    manifest.hooks.PreToolUse = [{ matcher: 'fixture', hooks: [{ type: 'command', command: 'node fixture.mjs' }] }];
    await writeFile(join(source, 'packaging/qwen-extension.json'), JSON.stringify(manifest));
    const output = join(directory, 'archives');
    execFileSync(python, ['-c',
        'import sys, pathlib; sys.path.insert(0, sys.argv[1]); import build_archives; build_archives.ROOT = pathlib.Path(sys.argv[2]); build_archives.build(pathlib.Path(sys.argv[3]))',
        join(repository, 'scripts'), source, output], { encoding: 'utf8', timeout: 30_000 });
    for (const platform of platforms) {
        const root = join(directory, platform);
        extract(join(output, archiveName(platform)), root);
        const packaged = JSON.parse(await readFile(join(root, 'qwen-extension.json'), 'utf8'));
        for (const definitions of Object.values(packaged.hooks)) {
            for (const definition of definitions) {
                for (const hook of definition.hooks) {
                    assert.equal(hook.shell, platform === 'win32' ? 'powershell' : undefined);
                }
            }
        }
    }
});

test('the source checkout cannot be silently installed as a platform package', () => {
    assert.equal(existsSync(join(repository, 'qwen-extension.json')), false,
        'Keep the template below packaging/ so Qwen source fallback cannot install a mismatched shell');
    assert.ok(existsSync(join(repository, 'packaging/qwen-extension.json')));
});

test('the extracted native package initializes and lists real MCP tools', async t => {
    const { directory, root, manifest } = await packageFor(t);
    const result = await startMcp(root, manifest, isolatedEnv(join(directory, 'state')));
    assert.ok(result.tools.some(tool => tool.name === 'wb_search_by_query'));
    assert.ok(result.tools.some(tool => tool.name === 'local_bridge_status'));
    t.diagnostic(`${process.platform}: initialize and tools/list succeeded (${result.tools.length} tools)`);
});

test('packaged entry points run through a linked directory and remain inactive when imported', async t => {
    const { directory, root, manifest } = await packageFor(t);
    // Both the link and its target belong to this test's temporary directory.
    // Unlink first, before the registered cleanup removes the temporary tree.
    const linkedRoot = join(directory, 'linked extension');
    await symlink(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const env = isolatedEnv(join(directory, 'state'));
    try {
        await t.test('MCP initializes through the linked path', async () => {
            const result = await startMcp(linkedRoot, manifest, env);
            assert.ok(result.tools.some(tool => tool.name === 'wb_search_by_query'));
        });
        await t.test('browser PostToolUse command consumes stdin through the linked path', async () => {
            const result = await run(process.execPath, [join(linkedRoot, 'qwen/browser-job-post.mjs')], {
                env, cwd: directory, input: 'invalid-json',
            });
            assert.equal(result.code, 2);
            assert.match(result.stderr, /^HANDOFF_INVALID_EVENT:/);
        });
        await t.test('feedback command consumes stdin through the linked path', async () => {
            const result = await run(process.execPath, [join(linkedRoot, 'qwen/feedback-handoff.mjs')], {
                env, cwd: directory, input: 'invalid-json',
            });
            assert.equal(result.code, 0, result.stderr);
            assert.ok(result.stdout.trim(), 'The feedback command must produce a denial for invalid input');
            assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
        });
        await t.test('the runnable feedback fixture initializes through the linked path', async () => {
            await mkdir(join(root, 'tests/fixtures'), { recursive: true });
            await cp(join(repository, 'tests/fixtures/feedback-mcp.mjs'), join(root, 'tests/fixtures/feedback-mcp.mjs'));
            const result = await run(process.execPath, [join(linkedRoot, 'tests/fixtures/feedback-mcp.mjs')], {
                env: { ...env, QWEN_FEEDBACK_FIXTURE_DIR: join(directory, 'feedback fixture') }, cwd: directory,
                input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
            });
            assert.equal(result.code, 0, result.stderr);
            assert.ok(result.stdout.trim(), 'The fixture must answer initialization');
            assert.equal(JSON.parse(result.stdout).result.serverInfo.name, 'feedback-fixture');
        });
        await t.test('importing linked command modules does not execute their entry points', async () => {
            const importer = join(directory, 'import-commands.mjs');
            const imports = ['browser-job-proxy.mjs', 'browser-job-post.mjs', 'feedback-handoff.mjs']
                .map(name => `await import(${JSON.stringify(pathToFileURL(join(linkedRoot, 'qwen', name)).href)});`).join('\n');
            await writeFile(importer, `${imports}\nconsole.log('imported');\n`);
            const result = await run(process.execPath, [importer], { env, cwd: directory, input: 'invalid-json' });
            assert.equal(result.code, 0, result.stderr);
            assert.equal(result.stdout.trim(), 'imported');
            assert.equal(result.stderr, '');
        });
    } finally {
        await unlink(linkedRoot);
    }
});

test('startup verification catches an archive missing MCP build metadata', async t => {
    const { directory, root, manifest } = await packageFor(t);
    await rm(join(root, 'mcp/package.json'));
    await assert.rejects(startMcp(root, manifest, isolatedEnv(join(directory, 'state'))), /Unable to resolve the local bridge build version/);
});

test('the packaged hook command stages one session-bound and tool-bound authorization from a path with spaces', async t => {
    const { directory, root, manifest } = await packageFor(t);
    const env = isolatedEnv(join(directory, 'state'));
    const hook = manifest.hooks.PostToolUse[0].hooks[0];
    // Qwen substitutes this plugin variable before dispatching to the configured shell.
    const command = hook.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root.replaceAll('\\', '/'));
    const shell = hook.shell === 'powershell' ? 'powershell' : '/bin/bash';
    const args = hook.shell === 'powershell' ? ['-Command', command] : ['-c', command];
    const token = 'https://example.invalid/browser-job#packaged-check';
    const post = { hook_event_name: 'PostToolUse', session_id: 'package-session', prompt_id: 'package-session########1',
        tool_name: 'mcp__e-comet__browser_job', tool_input: { job: { type: 'product_card' } },
        tool_response: { llmContent: [{ text: JSON.stringify({ trigger_url: token }) }] } };
    const staged = await run(shell, args, { env, cwd: root, input: JSON.stringify(post) });
    assert.equal(staged.code, 0, staged.stderr);
    assert.doesNotMatch(staged.stdout + staged.stderr, /packaged-check/);
    const { prepareBrowserCall } = await import(pathToFileURL(join(root, 'qwen/browser-job-proxy.mjs')).href);
    const call = (sessionId = 'package-session', name = 'wb_product_card', arguments_ = { articles: [123] }) => ({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_,
            _meta: { 'qwen-code/invocation': { version: 1, sessionId, promptId: 'native-prompt' } } },
    });
    const denied = async (message, reason) => {
        const result = await prepareBrowserCall(message, { env });
        assert.equal(result.message, undefined);
        assert.equal(result.response.result.isError, true);
        assert.match(result.response.result.content[0].text, reason);
        assert.doesNotMatch(JSON.stringify(result), /packaged-check|model-secret/);
    };
    await denied(call('another-session'), /^HANDOFF_MISSING:/);
    await denied(call('package-session', 'wb_search_by_query'), /^HANDOFF_MISSING:/);
    const withoutContext = call();
    delete withoutContext.params._meta;
    await denied(withoutContext, /^HANDOFF_QWEN_CONTEXT_REQUIRED:/);
    await denied(call('package-session', 'wb_product_card', { triggerUrl: 'model-secret' }), /^HANDOFF_MODEL_AUTHORIZATION:/);
    const prepared = await prepareBrowserCall(call(), { env });
    assert.deepEqual(prepared.message.params.arguments, { articles: [123], triggerUrl: token });
    await denied(call(), /^HANDOFF_MISSING:/);
    t.diagnostic(`${process.platform}: published ${shell} command and packaged adapter handoff succeeded`);
});

test('stock Qwen installs the native archive and executes its loaded hook with the real HookRunner', {
    skip: process.env.ECOMET_QWEN_CLI ? false : 'Set ECOMET_QWEN_CLI to the stock Qwen 0.25.0 cli-entry.js (required in CI)',
}, async t => {
    const directory = await temporary(t);
    const output = join(directory, 'archives');
    build(output);
    const result = await run(process.execPath, [join(repository, 'tests/native-qwen-check.mjs'),
        resolve(process.env.ECOMET_QWEN_CLI), join(output, archiveName(process.platform)), repository], {
        env: isolatedEnv(join(directory, 'state')), cwd: directory, timeoutMs: 60_000,
    });
    assert.equal(result.code, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.archiveInstall, true);
    assert.equal(evidence.nativeHookRunner, true);
    assert.equal(evidence.oneUseClaim, true);
    assert.equal(evidence.nativeFeedbackHook, true);
    assert.equal(evidence.nativeDoctorSkill, true);
    assert.equal(evidence.nativeDoctorDiagnosis, true);
    assert.equal(evidence.sourceFallbackRejected, true);
    t.diagnostic(JSON.stringify(evidence));
});
