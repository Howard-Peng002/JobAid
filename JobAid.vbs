' JobAid 启动器
' 某些环境（IDE、集成终端）会给子进程带上 ELECTRON_RUN_AS_NODE=1，
' 这会让 Electron 退化成纯 Node 进程，窗口起不来。这里先清掉再启动。
Option Explicit
Dim sh, root
Set sh = CreateObject("WScript.Shell")
root = "D:\JobAid"
On Error Resume Next
sh.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0
sh.CurrentDirectory = root
sh.Run """" & root & "\node_modules\electron\dist\electron.exe"" """ & root & """", 1, False
