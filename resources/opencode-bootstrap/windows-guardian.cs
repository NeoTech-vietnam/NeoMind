using System; using System.Runtime.InteropServices; using System.Text; using System.Threading.Tasks;
public static class WorkForceEngineJob {
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IO io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct START { public int cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2; public IntPtr bytes,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct FT { public uint low,high; }
 [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long a,b,c,d; public uint faults,total,active,terminated; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string b);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr a,int b,ref EXT c,uint d);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr a,IntPtr b);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr a,uint b);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr a,int b,out ACCOUNT c,uint d,IntPtr e);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref START start,out PROCESS info);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h,out FT a,out FT b,out FT c,out FT d);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr a,IntPtr b,IntPtr c,out IntPtr d,uint access,bool inherit,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string a,uint b,uint c,ref SA d,uint e,uint f,IntPtr g);
 static void Need(bool value) { if(!value) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 public static void Run() {
  string binary=Environment.GetEnvironmentVariable("WORKFORCE_ENGINE_BINARY"), cwd=Environment.GetEnvironmentVariable("WORKFORCE_ENGINE_DIRECTORY"), nonce=Environment.GetEnvironmentVariable("WORKFORCE_ENGINE_CONTROL");
  Environment.SetEnvironmentVariable("WORKFORCE_ENGINE_BINARY",null); Environment.SetEnvironmentVariable("WORKFORCE_ENGINE_DIRECTORY",null); Environment.SetEnvironmentVariable("WORKFORCE_ENGINE_CONTROL",null); Environment.SetEnvironmentVariable("WORKFORCE_ENGINE_GUARDIAN",null);
  IntPtr job=IntPtr.Zero, output=IntPtr.Zero, error=IntPtr.Zero, input=IntPtr.Zero; PROCESS p=new PROCESS();
  try {
   job=CreateJobObject(IntPtr.Zero,null); Need(job!=IntPtr.Zero); EXT limits=new EXT(); limits.basic.flags=0x2000;
   Need(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT))));
   Need(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-11),GetCurrentProcess(),out output,0,true,2));
   Need(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-12),GetCurrentProcess(),out error,0,true,2));
   SA sa=new SA();sa.length=Marshal.SizeOf(typeof(SA));sa.inherit=true; input=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero); Need(input!=new IntPtr(-1));
   START s=new START();s.cb=Marshal.SizeOf(typeof(START));s.flags=0x100;s.input=input;s.output=output;s.error=error;
   Console.WriteLine("WORKFORCE_ENGINE_STAGE "+nonce+" engine-create-started"); Console.Out.Flush();
   Need(CreateProcess(binary,new StringBuilder("\""+binary+"\" serve --hostname=127.0.0.1 --port=0"),IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,cwd,ref s,out p));
   Console.WriteLine("WORKFORCE_ENGINE_STAGE "+nonce+" engine-create-completed"); Console.Out.Flush();
   Need(AssignProcessToJobObject(job,p.process)); FT birth,unused1,unused2,unused3; Need(GetProcessTimes(p.process,out birth,out unused1,out unused2,out unused3));
   Console.WriteLine("WORKFORCE_ENGINE_IDENTITY "+nonce+" "+p.pid+" "+(((ulong)birth.high<<32)|birth.low)); Console.Out.Flush();
   Need(ResumeThread(p.thread)!=0xffffffff); CloseHandle(p.thread);p.thread=IntPtr.Zero;
   Task<int> owner=Task.Run(()=>Console.OpenStandardInput().ReadByte());
   while(WaitForSingleObject(p.process,100)==258 && !owner.IsCompleted) {}
   if(owner.IsCompleted) Need(TerminateJobObject(job,130));
   Need(WaitForSingleObject(p.process,5000)==0); uint code; Need(GetExitCodeProcess(p.process,out code));
   Need(TerminateJobObject(job,130)); ACCOUNT accounting; int waited=0;
   do { Need(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));if(accounting.active==0)break;System.Threading.Thread.Sleep(20);waited+=20; } while(waited<5000);
   Need(accounting.active==0); CloseHandle(job);job=IntPtr.Zero;
   Console.WriteLine("WORKFORCE_ENGINE_EXIT "+nonce+" "+code);Console.Out.Flush();
  } finally {
   if(job!=IntPtr.Zero)CloseHandle(job); if(p.process!=IntPtr.Zero){if(WaitForSingleObject(p.process,0)==258)TerminateProcess(p.process,130);CloseHandle(p.process);}if(p.thread!=IntPtr.Zero)CloseHandle(p.thread);
   if(input!=IntPtr.Zero&&input!=new IntPtr(-1))CloseHandle(input);if(output!=IntPtr.Zero)CloseHandle(output);if(error!=IntPtr.Zero)CloseHandle(error);
  }
 }
}
