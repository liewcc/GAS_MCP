Option Explicit
Dim fso, ws, sc, wmi, colItems, objItem
Dim root, desktop, wtPath, cols, rows, w, h

Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName) & "\"

' Query the primary display's resolution via WMI (no PowerShell involved).
w = 1920
h = 1080
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set colItems = wmi.ExecQuery("Select CurrentHorizontalResolution, CurrentVerticalResolution from Win32_VideoController")
For Each objItem In colItems
    If Not IsNull(objItem.CurrentHorizontalResolution) And objItem.CurrentHorizontalResolution > 0 Then
        w = objItem.CurrentHorizontalResolution
        h = objItem.CurrentVerticalResolution
        Exit For
    End If
Next
On Error Goto 0

' Half the screen, in terminal columns/rows -- approximate default console
' cell size (~10x20px at 100% DPI).
cols = Int((w / 2) / 10)
rows = Int((h / 2) / 20)
If cols < 80 Then cols = 80
If rows < 24 Then rows = 24

desktop = ws.SpecialFolders("Desktop")
wtPath = ws.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Microsoft\WindowsApps\wt.exe"

Set sc = ws.CreateShortcut(desktop & "\Google AI Studio MCP.lnk")
If fso.FileExists(wtPath) Then
    sc.TargetPath = wtPath
    sc.Arguments = "--size " & cols & "," & rows & " --title ""Google AI Studio MCP"" cmd /k """ & root & "run.bat"""
Else
    sc.TargetPath = root & "run.bat"
End If
sc.WorkingDirectory = root
sc.IconLocation = root & "logo\logo.ico"
sc.Save

WScript.Echo "  Shortcut created (" & cols & "x" & rows & " cols x rows), target: " & sc.TargetPath
