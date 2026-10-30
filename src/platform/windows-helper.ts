import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateBase } from './state-dir.js';

/**
 * Win32 job objects and process identity for workers. Compiled once per source hash with the
 * .NET Framework compiler shipped with Windows, so no binary is checked in. C# 5 syntax only.
 *
 *   run <name> <exe> [args...]  create Global\<name> with kill-on-close, join it, run exe, return its exit code
 *   query <name>                "absent" | "active <processes>"
 *   stop <name> <timeoutMs>     terminate the job: "absent" | "stopped" | "running <processes>" (exit 4)
 *   procinfo <pid>              "boot=<id> state=<alive|exited|absent|unknown> start=<filetime>"
 */
const source = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

static class NeoMindJob {
  const uint JOB_OBJECT_QUERY = 0x0004, JOB_OBJECT_TERMINATE = 0x0008;
  const uint KILL_ON_JOB_CLOSE = 0x2000, STARTF_USESTDHANDLES = 0x100, CREATE_UNICODE_ENVIRONMENT = 0x400;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, SYNCHRONIZE = 0x00100000, INFINITE = 0xFFFFFFFF;
  const int ERROR_FILE_NOT_FOUND = 2, ERROR_INVALID_PARAMETER = 87, ERROR_ALREADY_EXISTS = 183;

  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute; public uint dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  static int Fail(string message) { Console.Error.WriteLine("neomind-job: " + message + " (" + Marshal.GetLastWin32Error() + ")"); return 120; }
  static string JobName(string name) {
    if (!Regex.IsMatch(name, "^neomind-run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) throw new ArgumentException("invalid job name");
    return "Global\\" + name;
  }
  static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
    StringBuilder text = new StringBuilder("\"");
    for (int i = 0; ; i++) {
      int slashes = 0;
      while (i < arg.Length && arg[i] == '\\') { i++; slashes++; }
      if (i == arg.Length) { text.Append('\\', slashes * 2); break; }
      if (arg[i] == '"') { text.Append('\\', slashes * 2 + 1); text.Append('"'); }
      else { text.Append('\\', slashes); text.Append(arg[i]); }
    }
    return text.Append('"').ToString();
  }
  static bool Active(IntPtr job, out uint processes) {
    Accounting info;
    bool ok = QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero);
    processes = ok ? info.ActiveProcesses : 0;
    return ok;
  }

  static int Run(string[] args) {
    if (args.Length < 3) return Fail("usage: run <name> <exe> [args...]");
    string exe = args[2], extension = System.IO.Path.GetExtension(exe).ToLowerInvariant();
    if (!System.IO.Path.IsPathRooted(exe) || !string.Equals(System.IO.Path.GetFullPath(exe), exe, StringComparison.OrdinalIgnoreCase) || extension != ".exe") return Fail("run requires an absolute .exe path");
    IntPtr job = CreateJobObjectW(IntPtr.Zero, JobName(args[1]));
    if (job == IntPtr.Zero) return Fail("CreateJobObject failed");
    if (Marshal.GetLastWin32Error() == ERROR_ALREADY_EXISTS) return Fail("job already exists");
    ExtendedLimit limit = new ExtendedLimit();
    limit.Basic.LimitFlags = KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, 9, ref limit, Marshal.SizeOf(typeof(ExtendedLimit)))) return Fail("SetInformationJobObject failed");
    // Joining first makes every descendant a job member before it can run; breakaway is not permitted.
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) return Fail("AssignProcessToJobObject failed");
    StringBuilder commandLine = new StringBuilder();
    for (int i = 2; i < args.Length; i++) { if (i > 2) commandLine.Append(' '); commandLine.Append(Quote(args[i])); }
    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(-10); startup.hStdOutput = GetStdHandle(-11); startup.hStdError = GetStdHandle(-12);
    SetHandleInformation(startup.hStdInput, 1, 1); SetHandleInformation(startup.hStdOutput, 1, 1); SetHandleInformation(startup.hStdError, 1, 1);
    ProcessInformation child;
    if (!CreateProcessW(exe, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref startup, out child)) return Fail("CreateProcess failed");
    CloseHandle(child.hThread);
    WaitForSingleObject(child.hProcess, INFINITE);
    uint code;
    if (!GetExitCodeProcess(child.hProcess, out code)) code = 121;
    // Exiting closes the only job handle; kill-on-close ends any remaining descendants.
    return (int)code;
  }
  static int Query(string[] args) {
    if (args.Length != 2) return Fail("usage: query <name>");
    IntPtr job = OpenJobObjectW(JOB_OBJECT_QUERY, false, JobName(args[1]));
    if (job == IntPtr.Zero) {
      if (Marshal.GetLastWin32Error() == ERROR_FILE_NOT_FOUND) { Console.WriteLine("absent"); return 0; }
      return Fail("OpenJobObject failed");
    }
    uint processes;
    if (!Active(job, out processes)) return Fail("QueryInformationJobObject failed");
    Console.WriteLine("active " + processes);
    return 0;
  }
  static int Stop(string[] args) {
    if (args.Length != 3) return Fail("usage: stop <name> <timeoutMs>");
    IntPtr job = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, JobName(args[1]));
    if (job == IntPtr.Zero) {
      if (Marshal.GetLastWin32Error() == ERROR_FILE_NOT_FOUND) { Console.WriteLine("absent"); return 0; }
      return Fail("OpenJobObject failed");
    }
    if (!TerminateJobObject(job, 1)) return Fail("TerminateJobObject failed");
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(int.Parse(args[2]));
    uint processes = 0;
    while (true) {
      if (!Active(job, out processes)) return Fail("QueryInformationJobObject failed");
      if (processes == 0) { Console.WriteLine("stopped"); return 0; }
      if (DateTime.UtcNow > deadline) { Console.WriteLine("running " + processes); return 4; }
      System.Threading.Thread.Sleep(50);
    }
  }
  static int ProcInfo(string[] args) {
    if (args.Length != 2) return Fail("usage: procinfo <pid>");
    object boot = Registry.GetValue("HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters", "BootId", null);
    string state = "unknown", start = "";
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, int.Parse(args[1]));
    if (process == IntPtr.Zero) { if (Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER) state = "absent"; }
    else {
      long creation, exit, kernel, user;
      if (GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
        start = creation.ToString();
        uint wait = WaitForSingleObject(process, 0);
        state = wait == 0 ? "exited" : wait == 0x102 ? "alive" : "unknown";
      }
      CloseHandle(process);
    }
    Console.WriteLine("boot=" + (boot is int ? boot.ToString() : "") + " state=" + state + " start=" + start);
    return 0;
  }
  static int Main(string[] args) {
    try {
      if (args.Length > 0 && args[0] == "run") return Run(args);
      if (args.Length > 0 && args[0] == "query") return Query(args);
      if (args.Length > 0 && args[0] == "stop") return Stop(args);
      if (args.Length > 0 && args[0] == "procinfo") return ProcInfo(args);
      return Fail("unknown command");
    } catch (Exception error) { Console.Error.WriteLine("neomind-job: " + error.Message); return 122; }
  }
}
`;

let helper: string | undefined;

/** Path of the compiled helper; compiles on first use. Throws off Windows or without the .NET Framework compiler. */
export function windowsHelperPath(): string {
  if (helper) return helper;
  if (process.platform !== 'win32') throw new Error('The Windows job helper is only available on Windows');
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const directory = path.join(stateBase(), 'neomind', 'bin'), target = path.join(directory, `neomind-job-${digest}.exe`);
  if (!existsSync(target)) {
    const windows = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
    const compiler = path.join(windows, 'Microsoft.NET', process.arch === 'ia32' ? 'Framework' : 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!existsSync(compiler)) throw new Error(`.NET Framework 4 compiler not found at ${compiler}`);
    mkdirSync(directory, { recursive: true });
    const unique = path.join(directory, `neomind-job-${randomUUID()}`);
    try {
      writeFileSync(`${unique}.cs`, source, 'utf8');
      execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${unique}.exe`, `${unique}.cs`], { stdio: 'pipe', windowsHide: true, timeout: 120000 });
      try { renameSync(`${unique}.exe`, target); } catch (error) { if (!existsSync(target)) throw error; }
    } finally { rmSync(`${unique}.cs`, { force: true }); rmSync(`${unique}.exe`, { force: true }); }
  }
  return helper = target;
}

export interface WindowsProcessInfo { bootId: string; state: 'alive' | 'exited' | 'absent' | 'unknown'; start: string }
export function windowsProcessInfo(pid: number): WindowsProcessInfo | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const output = execFileSync(windowsHelperPath(), ['procinfo', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  const match = /^boot=(\d*) state=(alive|exited|absent|unknown) start=(\d*)$/.exec(output);
  return match ? { bootId: match[1]!, state: match[2] as WindowsProcessInfo['state'], start: match[3]! } : undefined;
}
