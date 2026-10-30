/** Signals that end a foreground NeoMind process. Windows maps Ctrl+C to SIGINT, Ctrl+Break to SIGBREAK and console close to SIGHUP. */
export const shutdownSignals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
export const signalExitCode = (signal: NodeJS.Signals) => signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : 130;

/**
 * The first signal runs `stop` (pause runs and confirm their workers stopped) before exiting. A second signal exits
 * at once; worker scopes then outlive this process and are stopped and reconciled when the run is resumed.
 */
export function installShutdown(stop: (signal: NodeJS.Signals) => Promise<void>,
  options: { exit?: (code: number) => void; log?: (message: string) => void; source?: Pick<NodeJS.EventEmitter, 'on' | 'off'> } = {}): () => void {
  const source = options.source ?? process, exit = options.exit ?? ((code: number) => process.exit(code)), log = options.log ?? ((message: string) => console.error(message));
  let stopping = false;
  const listener = (signal: NodeJS.Signals) => {
    if (stopping) {
      log('NeoMind: thoát ngay. Worker chưa được xác nhận dừng sẽ được dừng và đối chiếu khi tiếp tục run.');
      exit(signalExitCode(signal)); return;
    }
    stopping = true;
    log(`NeoMind: nhận ${signal}; đang tạm dừng run và xác nhận worker đã dừng. Nhấn lần nữa để thoát ngay.`);
    stop(signal).then(() => exit(signalExitCode(signal)), error => {
      log(`NeoMind: dừng chưa hoàn tất: ${error instanceof Error ? error.message : String(error)}`); exit(1);
    });
  };
  for (const signal of shutdownSignals) source.on(signal, listener);
  return () => { for (const signal of shutdownSignals) source.off(signal, listener); };
}
