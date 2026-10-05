// Synthetic acceptance fixture. Uses real feedback preparation, signatures and storage;
// the only upload implementation writes an archive under the explicitly supplied fixture directory.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isMainModule } from '../../qwen/entry-point.mjs';
import { prepareECometFeedback, submitECometFeedback } from '../../mcp/src/feedback-tools.mjs';
import { registerFeedbackArtifact, loadVerifiedFeedbackArtifact, retireFeedbackArtifact } from '../../mcp/src/feedback-artifact-store.mjs';
import { loadHookSecret, verifyHookSignature } from '../../mcp/src/hook-signature.mjs';
import { attachStdioTransport } from '../../mcp/src/stdio-transport.mjs';
import { tools } from '../../mcp/src/tool-catalog.mjs';

export const createFeedbackFixture = ({ env, directory }) => {
    if (!isAbsolute(directory)) throw new Error('An absolute isolated fixture directory is required.');
    const artifactDirectory = join(directory, 'artifacts');
    const verifySignature = async ({ tool, sessionHash, signature, fields }) => {
        const secret = await loadHookSecret({ env, create: false });
        if (!verifyHookSignature({ secret, tool, sessionHash, signature, fields })) throw new Error('Fixture rejected invalid hook signature.');
    };
    return { artifactDirectory, async call(name, args) {
        if (name === 'report_issue') return {
            upload_url: 'https://storage.yandexcloud.net/e-comet-mcp-feedback/synthetic.zip?fixture=never-send',
            object_key: 'synthetic/feedback.zip', required_headers: { 'Content-Type': 'application/zip' },
            expires_at: Math.floor(Date.now() / 1000) + 900,
        };
        if (name === 'prepare_e_comet_feedback') return prepareECometFeedback(args, {
            getBridgeStatus: () => ({}), verifySignature,
            registerArtifact: artifact => registerFeedbackArtifact(artifact, { artifactDirectory }),
        });
        if (name === 'submit_e_comet_feedback') return submitECometFeedback(args, {
            verifySignature,
            loadArtifact: input => loadVerifiedFeedbackArtifact(input, { artifactDirectory }),
            retireArtifact: input => retireFeedbackArtifact(input, { artifactDirectory }),
            upload: async ({ bytes }) => {
                const output = join(directory, 'uploads');
                await mkdir(output, { recursive: true });
                await writeFile(join(output, `${args.artifactId}.zip`), bytes, { flag: 'wx' });
                await writeFile(join(output, `${args.artifactId}.json`), JSON.stringify({ artifactId: args.artifactId,
                    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }), { flag: 'wx' });
            },
        });
        throw new Error('Unknown feedback fixture tool.');
    } };
};

if (isMainModule(import.meta.url)) {
    const fixture = createFeedbackFixture({ env: process.env, directory: process.env.QWEN_FEEDBACK_FIXTURE_DIR });
    const remote = process.argv.includes('--remote');
    const catalog = remote ? [{ name: 'report_issue', description: 'Authorize a synthetic feedback archive; never contacts a service.',
        inputSchema: { type: 'object', properties: { kind: { type: 'string' }, size_bytes: { type: 'integer' } }, required: ['kind', 'size_bytes'], additionalProperties: false } }]
        : tools.filter(tool => ['prepare_e_comet_feedback', 'submit_e_comet_feedback'].includes(tool.name));
    const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
    attachStdioTransport({ input: process.stdin, sendError: (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } }),
        handleMessage: async message => {
            if (!Object.hasOwn(message, 'id')) return;
            let result;
            if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'feedback-fixture', version: '1' } };
            else if (message.method === 'tools/list') result = { tools: catalog };
            else if (message.method === 'tools/call') {
                try { const value = await fixture.call(message.params.name, message.params.arguments);
                    result = { isError: value.ok === false, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
                } catch (error) { result = { isError: true, content: [{ type: 'text', text: `${error.code ?? 'FIXTURE_ERROR'}: ${error.message}` }] }; }
            } else result = {};
            send({ jsonrpc: '2.0', id: message.id, result });
        },
    });
}
