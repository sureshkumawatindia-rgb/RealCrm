' ============================================================================
'  start-crm.vbs - opens the CRM on this computer WITHOUT any black window
' ============================================================================
'  Double-click this file. Nothing appears on screen: the CRM starts in the
'  background on http://127.0.0.1:3000 and opens in the browser.
'  ONE server does everything - the backend (API) also serves the CRM pages,
'  so there is no Live Server or "npm run dev" to start.
'  A CRM that is already running (VS Code, a terminal) is simply reused.
'
'  Stop it later with stop-crm.vbs
'  If something goes wrong, the details are in launcher\logs\backend.log
' ============================================================================
Option Explicit

Const PORT = 3000

Dim shell, fso, here, backendDir, serverJs, logDir, healthUrl, crmUrl, started

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
backendDir = here & "backend\"
serverJs = backendDir & "src\server.js"
logDir = here & "launcher\logs\"
healthUrl = "http://127.0.0.1:" & PORT & "/api/v1/health"
crmUrl = "http://127.0.0.1:" & PORT & "/crm/frontend/index.html"

If Not IsCrmApi(healthUrl) Then
  If Status(healthUrl) > 0 Then
    Fail "Something else is already using port " & PORT & "." & vbCrLf & vbCrLf & _
         "Close that program and run this file again."
  End If

  If shell.Run("cmd /c where node", 0, True) <> 0 Then
    Fail "Node.js is not installed." & vbCrLf & vbCrLf & _
         "Download it from https://nodejs.org, install it and run this file again."
  End If

  If Not fso.FolderExists(backendDir & "node_modules") Then
    Fail "The backend packages are not installed yet." & vbCrLf & vbCrLf & _
         "Open a terminal in the backend folder, run  npm install  once," & vbCrLf & _
         "then run this file again."
  End If

  If Not fso.FolderExists(here & "launcher\") Then fso.CreateFolder here & "launcher\"
  If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

  ' The backend reads backend\.env from the folder it starts in.
  shell.CurrentDirectory = backendDir
  shell.Environment("PROCESS")("DOTENV_CONFIG_QUIET") = "true"
  shell.Run "cmd /c node """ & serverJs & """ > """ & logDir & "backend.log"" 2>&1", 0, False

  ' Connecting to the database can take a few seconds.
  started = Timer
  Do While Seconds(started) < 60
    WScript.Sleep 500
    If IsCrmApi(healthUrl) Then Exit Do
    If Seconds(started) > 2 And Not NodeRuns(serverJs) Then Exit Do
  Loop

  If Not IsCrmApi(healthUrl) Then
    Fail "The CRM could not be started." & vbCrLf & vbCrLf & _
         LastLines(logDir & "backend.log", 8) & vbCrLf & vbCrLf & _
         "Full details are in launcher\logs\backend.log"
  End If
End If

shell.Run crmUrl, 1, False

' --- shows the problem and stops ---------------------------------------------
Sub Fail(message)
  MsgBox message, vbExclamation, "CRM"
  WScript.Quit 1
End Sub

' --- HTTP status of that address, 0 when nothing answers ---------------------
Function Status(address)
  Dim http
  Status = 0
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 2000, 2000, 2000, 5000
  http.Open "GET", address, False
  http.Send
  If Err.Number = 0 Then Status = http.Status
  On Error GoTo 0
End Function

' --- true when the CRM backend answers its health check ----------------------
Function IsCrmApi(address)
  Dim http
  IsCrmApi = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 2000, 2000, 2000, 5000
  http.Open "GET", address, False
  http.Send
  If Err.Number = 0 Then
    If InStr(http.responseText, """dbState""") > 0 Then IsCrmApi = True
  End If
  On Error GoTo 0
End Function

' --- true while a node.exe is running that script ----------------------------
Function NodeRuns(script)
  Dim proc
  NodeRuns = False
  For Each proc In GetObject("winmgmts:\\.\root\cimv2").ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
    If InStr(1, "" & proc.CommandLine, script, vbTextCompare) > 0 Then NodeRuns = True
  Next
End Function

' --- seconds since a Timer value (Timer starts again at midnight) ------------
Function Seconds(since)
  Seconds = Timer - since
  If Seconds < 0 Then Seconds = Seconds + 86400
End Function

' --- the last lines of a log file, to show what went wrong -------------------
Function LastLines(file, count)
  Dim colors, text, lines, first, i
  LastLines = ""
  If Not fso.FileExists(file) Then Exit Function
  If fso.GetFile(file).Size = 0 Then Exit Function

  ' the backend log is colored for a terminal; drop the color codes
  Set colors = New RegExp
  colors.Pattern = Chr(27) & "\[[0-9;]*m"
  colors.Global = True

  text = Replace(colors.Replace(fso.OpenTextFile(file, 1).ReadAll, ""), vbCr, "")
  Do While Right(text, 1) = vbLf
    text = Left(text, Len(text) - 1)
  Loop
  lines = Split(text, vbLf)

  first = UBound(lines) - count + 1
  If first < 0 Then first = 0
  For i = first To UBound(lines)
    LastLines = LastLines & Left(lines(i), 150) & vbCrLf
  Next
End Function
