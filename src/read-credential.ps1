param(
  [string]$Target = "APE_TALLY_CONNECTOR_KEY"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TallyConnectorCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public UInt32 Flags;
        public UInt32 Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("Advapi32.dll", SetLastError = false)]
    private static extern void CredFree(IntPtr credential);

    public static string Read(string target) {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer)) return null;
        try {
            CREDENTIAL credential = Marshal.PtrToStructure<CREDENTIAL>(pointer);
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return null;
            return Marshal.PtrToStringUni(credential.CredentialBlob, (int)(credential.CredentialBlobSize / 2));
        } finally {
            CredFree(pointer);
        }
    }
}
'@

$credential = [TallyConnectorCredential]::Read($Target)
if ([string]::IsNullOrWhiteSpace($credential)) { exit 2 }
[Console]::Out.Write($credential)
