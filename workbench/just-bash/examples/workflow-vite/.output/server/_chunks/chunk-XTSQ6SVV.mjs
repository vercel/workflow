import { D as DEFAULT_BATCH_SIZE, _ as __name } from "../index.mjs";
async function readFiles(ctx, files, options) {
  const { cmdName, allowStdinMarker = true, stopOnError = false, batchSize = DEFAULT_BATCH_SIZE } = options;
  if (files.length === 0) {
    return {
      files: [{ filename: "", content: ctx.stdin }],
      stderr: "",
      exitCode: 0
    };
  }
  const result = [];
  let stderr = "";
  let exitCode = 0;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (file) => {
      if (allowStdinMarker && file === "-") {
        return { filename: "-", content: ctx.stdin, error: null };
      }
      try {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        const content = await ctx.fs.readFile(filePath, "binary");
        return { filename: file, content, error: null };
      } catch {
        return {
          filename: file,
          content: "",
          error: `${cmdName}: ${file}: No such file or directory
`
        };
      }
    }));
    for (const r of batchResults) {
      if (r.error) {
        stderr += r.error;
        exitCode = 1;
        if (stopOnError) {
          return { files: result, stderr, exitCode };
        }
      } else {
        result.push({ filename: r.filename, content: r.content });
      }
    }
  }
  return { files: result, stderr, exitCode };
}
__name(readFiles, "readFiles");
async function readAndConcat(ctx, files, options) {
  const result = await readFiles(ctx, files, {
    ...options,
    stopOnError: true
  });
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: { stdout: "", stderr: result.stderr, exitCode: result.exitCode }
    };
  }
  const content = result.files.map((f) => f.content).join("");
  return { ok: true, content };
}
__name(readAndConcat, "readAndConcat");
export {
  readAndConcat as a,
  readFiles as r
};
