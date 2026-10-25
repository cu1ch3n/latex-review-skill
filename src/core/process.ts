import {
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithBufferEncoding,
} from "node:child_process";
export class ProcessError extends Error {
  constructor(
    message: string,
    public stdout = Buffer.alloc(0),
    public stderr = Buffer.alloc(0),
    public code = 1,
  ) {
    super(message);
  }
}
export function run(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithBufferEncoding & { check?: boolean } = {},
) {
  const { check = true, ...rest } = options;
  const result = spawnSync(command, args, {
    timeout: 300000,
    maxBuffer: 128 * 1024 * 1024,
    ...rest,
  });
  if (result.error) throw result.error;
  if (check && result.status !== 0)
    throw new ProcessError(
      result.stderr?.toString().trim() ||
        `${command} failed (${result.status})`,
      result.stdout,
      result.stderr,
      result.status ?? 1,
    );
  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
    status: result.status ?? 1,
  };
}
const running = new Set<ReturnType<typeof spawn>>();
export function stopAll() {
  for (const child of running) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
}
export function runAsync(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    output?: (chunk: Buffer) => void;
  } = {},
) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    const chunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, options.timeout ?? 300000);
    const receive = (data: Buffer) => {
      chunks.push(data);
      options.output?.(data);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.on("error", (error) => {
      clearTimeout(timer);
      running.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      running.delete(child);
      const data = Buffer.concat(chunks);
      if (code === 0 && !timedOut) resolve(data);
      else
        reject(
          new ProcessError(
            timedOut ? `${command} timed out` : `${command} failed (${code})`,
            data,
            data,
            code ?? 1,
          ),
        );
    });
  });
}
export function which(command: string): string | null {
  const found = run("which", [command], { check: false });
  return found.status === 0 ? found.stdout.toString().trim() : null;
}
