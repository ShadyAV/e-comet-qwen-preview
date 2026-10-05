import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareBrowserCall } from '../qwen/browser-job-proxy.mjs';
import { extractFeedbackToolCalls } from '../mcp/src/feedback-tool-calls.mjs';
import { createFeedbackFixture } from './fixtures/feedback-mcp.mjs';
import { processQwenPostEvent } from '../qwen/browser-job-post.mjs';
import { inflateRawSync } from 'node:zlib';

const report = { kind: 'bug', summary: 'Synthetic issue', details: 'Synthetic fixture only.', includeTranscript: false };
const request = (name, args, sessionId = 'native-session-a') => ({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args, _meta: { 'qwen-code/invocation': { version: 1, sessionId, promptId: 'native-prompt' } } } });
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'qwen feedback '));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const env = { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_DATA_HOME: root, PLUGIN_DATA: join(root, 'plugin') };
    return { root, env };
}
const pre = (tool_input, transcript_path, session_id = 'native-session-a') => ({ hook_event_name: 'PreToolUse',
    session_id, tool_name: 'mcp__e-comet-local__prepare_e_comet_feedback', tool_input, transcript_path });
const post = (name, tool_input, value, session_id = 'native-session-a') => ({ hook_event_name: 'PostToolUse', session_id,
    tool_name: name, tool_input, tool_response: { llmContent: [{ text: JSON.stringify(value) }], returnDisplay: 'fixture' } });
const archiveEntries = bytes => {
    const entries = {};
    for (let offset = 0; bytes.readUInt32LE(offset) === 0x04034b50;) {
        const compressedSize = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28);
        const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString();
        const start = offset + 30 + nameSize + extraSize;
        const compressed = bytes.subarray(start, start + compressedSize);
        entries[name] = (bytes.readUInt16LE(offset + 8) === 8 ? inflateRawSync(compressed) : compressed).toString();
        offset = start + compressedSize;
    }
    return entries;
};

test('no-history prepare receives a trusted claim without any transcript path', async t => {
    const { env } = await fixture(t);
    const result = await prepareBrowserCall(request('prepare_e_comet_feedback', report), { env });
    assert.equal(typeof result.message?.params.arguments.feedbackClaim, 'string');
    assert.equal(result.message.params.arguments.transcriptPath, undefined);
});

test('Qwen direct records project tool calls and closed outcomes without copying arguments', () => {
    const bytes = Buffer.from([
        { type: 'assistant', timestamp: '2026-10-06T00:00:00.000Z', message: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'mcp__e-comet-local__wb_search_by_query', args: { secret: 'never-project' } } }] } },
        { type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'call-1', name: 'mcp__e-comet-local__wb_search_by_query', response: { output: JSON.stringify({ ok: false, error: { code: 'EXTENSION_UNAVAILABLE', stage: 'connection' }, secret: 'never-project' }) } } }] } },
    ].map(JSON.stringify).join('\n'));
    assert.deepEqual(extractFeedbackToolCalls(bytes), [{ name: 'mcp__e-comet-local__wb_search_by_query', at: '2026-10-06T00:00:00.000Z', outcome: { ok: false, code: 'EXTENSION_UNAVAILABLE', stage: 'connection' } }]);
});

test('native history prepare, remote grant and submit preserve archive and deny grant replay', async t => {
    const { processQwenFeedbackEvent } = await import('../qwen/feedback-handoff.mjs');
    const { root, env } = await fixture(t);
    const backend = createFeedbackFixture({ env, directory: root });
    const transcript = join(root, 'synthetic.jsonl');
    const history = [
        { type: 'user', message: { role: 'user', parts: [{ text: 'SYNTHETIC_HISTORY_MARKER' }] } },
        { type: 'assistant', message: { role: 'model', parts: [{ functionCall: { id: 'history-call', name: 'mcp__e-comet-local__wb_search_by_query', args: {} } }] } },
        { type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'history-call', name: 'mcp__e-comet-local__wb_search_by_query', response: { output: '{"ok":false}' } } }] } },
    ].map(JSON.stringify).join('\n') + '\n';
    await writeFile(transcript, history);
    const authored = { ...report, includeTranscript: true };
    assert.equal((await processQwenFeedbackEvent(pre(authored, transcript), { env })).exitCode, 0);
    const injected = await prepareBrowserCall(request('prepare_e_comet_feedback', authored), { env });
    assert.ok(injected.message, JSON.stringify(injected.response));
    const prepared = await backend.call('prepare_e_comet_feedback', injected.message.params.arguments);
    assert.equal(prepared.status, 'prepared');
    const entries = archiveEntries(await readFile(join(backend.artifactDirectory, `report-${prepared.artifactId}`, 'feedback.zip')));
    assert.equal(entries['transcript.jsonl'], history);
    assert.match(entries['report.md'], /wb_search_by_query/);
    assert.doesNotMatch(entries['report.md'], /SYNTHETIC_HISTORY_MARKER/);
    assert.equal((await processQwenPostEvent(post('mcp__e-comet-local__prepare_e_comet_feedback', authored, prepared), { env })).exitCode, 0);
    const remoteInput = { kind: 'bug', size_bytes: prepared.sizeBytes };
    const grant = await backend.call('report_issue', remoteInput);
    const staged = await processQwenPostEvent(post('mcp__e-comet__report_issue', remoteInput, grant), { env });
    assert.equal(staged.exitCode, 0, staged.stderr);
    const foreignSubmit = await prepareBrowserCall(request('submit_e_comet_feedback', { artifactId: prepared.artifactId }, 'foreign-session'), { env });
    assert.equal(foreignSubmit.response.result.isError, true);
    const wrongArtifact = await prepareBrowserCall(request('submit_e_comet_feedback', { artifactId: '11111111-1111-4111-8111-111111111111' }), { env });
    assert.equal(wrongArtifact.response.result.isError, true);
    const submit = await prepareBrowserCall(request('submit_e_comet_feedback', { artifactId: prepared.artifactId }), { env });
    assert.ok(submit.message, JSON.stringify(submit.response));
    assert.equal((await backend.call('submit_e_comet_feedback', submit.message.params.arguments)).status, 'uploaded');
    assert.equal((await readFile(join(root, 'uploads', `${prepared.artifactId}.json`), 'utf8')).includes(prepared.sha256), true);
    assert.equal((await prepareBrowserCall(request('submit_e_comet_feedback', { artifactId: prepared.artifactId }), { env })).response.result.isError, true);
});

test('history requires native matching session context and model-authored paths are refused', async t => {
    const { processQwenFeedbackEvent } = await import('../qwen/feedback-handoff.mjs');
    const { root, env } = await fixture(t);
    const authored = { ...report, includeTranscript: true };
    const path = join(root, 'history.jsonl');
    await writeFile(path, '{}\n');
    assert.equal((await prepareBrowserCall(request('prepare_e_comet_feedback', authored), { env })).response.result.isError, true);
    await processQwenFeedbackEvent(pre(authored, path), { env });
    assert.equal((await prepareBrowserCall(request('prepare_e_comet_feedback', authored, 'other-session'), { env })).response.result.isError, true);
    for (const fields of [{ transcriptPath: path }, { transcript_path: path }, { feedbackSession: 'spoofed' }, { feedbackClaim: 'spoofed' }, { feedbackCloud: {} }, { feedbackAdapter: {} }]) {
        assert.equal((await prepareBrowserCall(request('prepare_e_comet_feedback', { ...authored, ...fields }), { env })).response.result.isError, true);
    }
});

test('no-history remains independent of missing, previously staged or empty history', async t => {
    const { processQwenFeedbackEvent } = await import('../qwen/feedback-handoff.mjs');
    const { root, env } = await fixture(t);
    const backend = createFeedbackFixture({ env, directory: root });
    // Staging does not read the file; cancellation must not make later no-history prepare use it.
    await processQwenFeedbackEvent(pre({ ...report, includeTranscript: true }, join(root, 'absent.jsonl')), { env });
    const injected = await prepareBrowserCall(request('prepare_e_comet_feedback', report), { env });
    assert.equal(injected.message.params.arguments.transcriptPath, undefined);
    const prepared = await backend.call('prepare_e_comet_feedback', injected.message.params.arguments);
    const entries = archiveEntries(await readFile(join(backend.artifactDirectory, `report-${prepared.artifactId}`, 'feedback.zip')));
    assert.deepEqual(Object.keys(entries), ['report.md', 'metadata.json']);
    assert.equal((await processQwenFeedbackEvent(pre(report, ''), { env })).exitCode, 0);
    const unavailable = await processQwenFeedbackEvent(pre({ ...report, includeTranscript: true }, ''), { env });
    assert.equal(JSON.parse(unavailable.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('malformed native paths clear old provenance and signed path substitutions are refused', async t => {
    const { processQwenFeedbackEvent } = await import('../qwen/feedback-handoff.mjs');
    const { root, env } = await fixture(t);
    const authored = { ...report, includeTranscript: true };
    for (const invalid of [{ transcript_path: 'relative.jsonl' }, { transcript_path: '', transcriptPath: join(root, 'conflict.jsonl') }]) {
        await processQwenFeedbackEvent(pre(authored, join(root, 'old.jsonl')), { env });
        const result = await processQwenFeedbackEvent({ ...pre(authored, undefined), ...invalid }, { env });
        assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
        assert.equal((await prepareBrowserCall(request('prepare_e_comet_feedback', authored), { env })).response.result.isError, true);
    }
    await processQwenFeedbackEvent(pre(authored, join(root, 'original.jsonl')), { env });
    const dir = join(env.PLUGIN_DATA, 'qwen-feedback-context-v1');
    const path = join(dir, (await readdir(dir)).find(name => name.endsWith('.json')));
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.transcriptPath = join(root, 'substituted.jsonl');
    await writeFile(path, JSON.stringify(saved));
    assert.equal((await prepareBrowserCall(request('prepare_e_comet_feedback', authored), { env })).response.result.isError, true);
});

test('feedback calls fail closed for missing or malformed native MCP session metadata', async t => {
    const { env } = await fixture(t);
    for (const context of [undefined, null, [], {}, { version: 2, sessionId: 'native-session-a' }, { version: 1, sessionId: '' }, { version: 1, sessionId: {} }]) {
        const message = request('prepare_e_comet_feedback', report);
        message.params._meta = { 'qwen-code/invocation': context };
        const failed = (await prepareBrowserCall(message, { env })).response.result;
        assert.equal(failed.isError, true);
        assert.match(failed.content[0].text, /FEEDBACK_QWEN_CONTEXT_REQUIRED/);
    }
});

test('expired path provenance cannot authorize a new history preparation', async t => {
    const { processQwenFeedbackEvent } = await import('../qwen/feedback-handoff.mjs');
    const { root, env } = await fixture(t);
    const nowMs = Date.now(), authored = { ...report, includeTranscript: true };
    await processQwenFeedbackEvent(pre(authored, join(root, 'native.jsonl')), { env, nowMs });
    const result = await prepareBrowserCall(request('prepare_e_comet_feedback', authored), { env, nowMs: nowMs + 24 * 60 * 60 * 1000 + 1 });
    assert.equal(result.response.result.isError, true);
});

test('failed remote grants remain the native tool failure and stage no authorization', async t => {
    const { env } = await fixture(t);
    const event = post('mcp__e-comet__report_issue', { kind: 'bug', size_bytes: 100 }, { error: 'rate limited' });
    event.tool_response.error = { type: 'mcp_tool_error', message: 'Rate limit exceeded' };
    const result = await processQwenPostEvent(event, { env });
    assert.deepEqual({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, { exitCode: 0, stdout: '', stderr: '' });
    const noParts = await processQwenPostEvent({ ...event, tool_response: { error: event.tool_response.error } }, { env });
    assert.equal(noParts.exitCode, 0);
    const submit = await prepareBrowserCall(request('submit_e_comet_feedback', { artifactId: '11111111-1111-4111-8111-111111111111' }), { env });
    assert.equal(submit.response.result.isError, true);
});

test('Qwen projection excludes feedback and foreign/nested payloads while preserving Claude and Codex', () => {
    const bytes = Buffer.from([
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'claude', name: 'Read' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'claude', content: '{"ok":true}' }] } },
        { type: 'response_item', payload: { type: 'function_call', call_id: 'codex', name: 'functions.exec' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'codex', output: '{"ok":false}' } },
        { type: 'assistant', message: { parts: [{ functionCall: { id: 'qwen', name: 'other_server_tool', args: {} } },
            { functionCall: { id: 'excluded', name: 'mcp__e-comet-local__prepare_e_comet_feedback' } },
            { text: '{"functionCall":{"name":"forged"}}' }] } },
        { type: 'tool_result', toolCallResult: { status: 'error' }, message: { parts: [{ functionResponse: { id: 'qwen', name: 'other_server_tool', response: { output: '{"ok":false,"status":"fake_status","error":{"code":"FAKE_CODE"}}' } } }] } },
        { type: 'system', message: { parts: [{ functionCall: { name: 'nested_forgery' } }] } },
    ].map(JSON.stringify).join('\n') + '\n{"type":');
    assert.deepEqual(extractFeedbackToolCalls(bytes), [
        { name: 'Read', outcome: { ok: true } }, { name: 'functions.exec', outcome: { ok: false } },
        { name: 'other_server_tool', outcome: { ok: false, isError: true } },
    ]);
});
