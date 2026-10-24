# Runs one command with a processor-affinity mask and priority class (Windows), waits for it,
# appends its stdout/stderr to a log file and exits with its exit code.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/pin.ps1 <mask> <priority> <log> <exe> <arg line>
# Used by tools/run-r8-final.sh: timing jobs on one P core (mask 0x4 = logical CPU 2, AboveNormal),
# correctness jobs on the E cores (logical CPUs 12-19, mask 0xFF000, Normal).
# No param() block: with -File, a bound [string] parameter rejects a value that starts with "-"
# (e.g. "--expose-gc ..."), so the five arguments are read from $args. Call with MSYS_NO_PATHCONV=1
# from Git Bash so that "G:/..." inside the argument line is not rewritten.
$Mask = $args[0]; $Prio = $args[1]; $Log = $args[2]; $Exe = $args[3]; $ArgLine = $args[4]
$out = "$Log.stdout.tmp"
$err = "$Log.stderr.tmp"
$p = Start-Process -FilePath $Exe -ArgumentList $ArgLine -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
if ($null -eq $p) { Add-Content -Path $Log -Value "pin: process did not start"; exit 1 }
$null = $p.Handle  # needed for ExitCode with -PassThru
try {
  $p.ProcessorAffinity = [IntPtr][Convert]::ToInt64($Mask, 16)
  $p.PriorityClass = $Prio
} catch {
  Add-Content -Path $Log -Value "pin: could not set affinity/priority: $_"
}
$p.WaitForExit()
$code = $p.ExitCode
Add-Content -Path $Log -Value ("pin: affinity=0x{0} priority={1} pid={2}" -f $Mask, $Prio, $p.Id)
if (Test-Path $out) { Get-Content $out | Add-Content -Path $Log; Remove-Item $out }
if (Test-Path $err) { Get-Content $err | Add-Content -Path $Log; Remove-Item $err }
exit $code
