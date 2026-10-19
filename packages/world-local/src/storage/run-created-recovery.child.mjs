import fs from 'node:fs/promises';
import { register } from 'node:module';
import path from 'node:path';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const [mode, dataDir, runId, specVersionArg, extra] = process.argv.slice(2);
const specVersion = Number(specVersionArg);

async function send(message) {
  await new Promise((resolve, reject) => {
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function park(stage) {
  await send({ status: 'checkpoint', stage });
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
}

if (mode === 'crash-create') {
  const stage = extra;
  const writeFile = fs.writeFile.bind(fs);
  const link = fs.link.bind(fs);
  fs.writeFile = async (file, data, options) => {
    const isCreationTemp =
      String(file).includes(`${path.sep}events${path.sep}`) &&
      JSON.parse(String(data)).eventType === 'run_created';
    if (isCreationTemp && stage === 'before-event-temp') {
      await park(stage);
    }
    const result = await writeFile(file, data, options);
    if (isCreationTemp && stage === 'after-event-temp') {
      await park(stage);
    }
    return result;
  };
  fs.link = async (source, destination) => {
    const isCreationLink = String(destination).includes(
      `${path.sep}events${path.sep}`
    );
    if (isCreationLink && stage === 'before-event-link') {
      await park(stage);
    }
    const result = await link(source, destination);
    if (isCreationLink && stage === 'after-event-link') {
      await park(stage);
    }
    return result;
  };
}

const { createStorage } = await import('../storage.ts');

const originalCreation = {
  eventType: 'run_created',
  specVersion,
  eventData: {
    deploymentId: 'dpl_original',
    workflowName: 'workflow//original//entry',
    input: new Uint8Array([1, 2, 3]),
    executionContext: { requestId: 'original' },
    attributes: { tenant: 'original', $reserved: 'preserved' },
    allowReservedAttributes: true,
    encryptionPublicKey: `${'A'.repeat(43)}=`,
    dynamicWorkflowCode: new Uint8Array([4, 5, 6]),
  },
};

if (mode === 'crash-create') {
  try {
    await createStorage(dataDir).events.create(runId, originalCreation);
    await send({ status: 'unexpected-completion' });
  } catch (error) {
    await send({
      status: 'error',
      message: String(error?.message ?? error),
    });
  }
} else if (mode === 'start') {
  const storage = createStorage(dataDir);
  process.once('message', async (message) => {
    if (message !== 'go') return;
    try {
      const result = await storage.events.create(runId, {
        eventType: 'run_started',
        specVersion,
        eventData: {
          deploymentId: 'dpl_redelivered',
          workflowName: 'workflow//redelivered//entry',
          input: new Uint8Array([9]),
        },
      });
      await send({
        status: 'started',
        runStatus: result.run?.status,
        input: Array.from(result.run?.input ?? []),
      });
    } catch (error) {
      await send({
        status: 'error',
        name: error?.name,
        message: String(error?.message ?? error),
      });
    } finally {
      process.exit(0);
    }
  });
  await send({ status: 'ready' });
} else {
  await send({ status: 'error', message: `Unknown child mode: ${mode}` });
  process.exit(1);
}
