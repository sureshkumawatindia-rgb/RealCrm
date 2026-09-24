' ============================================================================
'  stop-crm.vbs - stops the CRM WITHOUT any black window
' ============================================================================
'  Double-click this file. It stops the CRM server (port 3000), whether
'  start-crm.vbs, VS Code or a terminal started it.
'  The Gynofem website (5500) and VS Code Live Server (5501) are left alone.
' ============================================================================
Option Explicit

If StopNodeOnPort(3000) > 0 Then
  MsgBox "The CRM was stopped." & vbCrLf & vbCrLf & _
         "Start it again: double-click start-crm.vbs", vbInformation, "CRM"
Else
  MsgBox "The CRM was not running.", vbInformation, "CRM"
End If

' --- stops the node.exe listening on that port, returns how many -------------
Function StopNodeOnPort(port)
  Dim net, cim, conn, proc
  StopNodeOnPort = 0
  Set net = GetObject("winmgmts:\\.\root\StandardCimv2")
  Set cim = GetObject("winmgmts:\\.\root\cimv2")
  ' State 2 = listening
  For Each conn In net.ExecQuery("SELECT OwningProcess FROM MSFT_NetTCPConnection WHERE LocalPort = " & port & " AND State = 2")
    For Each proc In cim.ExecQuery("SELECT * FROM Win32_Process WHERE ProcessId = " & conn.OwningProcess & " AND Name = 'node.exe'")
      proc.Terminate
      StopNodeOnPort = StopNodeOnPort + 1
    Next
  Next
End Function
