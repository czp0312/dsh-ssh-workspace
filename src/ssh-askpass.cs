using System;
using System.IO;
using System.IO.Pipes;
using System.Text;

// No UI and no credential persistence. OpenSSH receives only the requested answer on stdout.
class SshAskpass {
    static int Main(string[] args) {
        try {
            string endpoint = Environment.GetEnvironmentVariable("DSH_SSH_ASKPASS_PIPE");
            string token = Environment.GetEnvironmentVariable("DSH_SSH_ASKPASS_TOKEN");
            if (String.IsNullOrEmpty(endpoint) || !endpoint.StartsWith(@"\\.\pipe\") || String.IsNullOrEmpty(token)) return 1;
            using (var pipe = new NamedPipeClientStream(".", endpoint.Substring(9), PipeDirection.InOut, PipeOptions.Asynchronous)) {
                pipe.Connect(5000);
                var encoding = new UTF8Encoding(false);
                using (var writer = new StreamWriter(pipe, encoding, 1024, true))
                using (var reader = new StreamReader(pipe, encoding, false, 1024, true)) {
                    writer.WriteLine(token);
                    writer.WriteLine(Convert.ToBase64String(encoding.GetBytes(args.Length == 0 ? "" : args[0])));
                    writer.Flush();
                    if (reader.ReadLine() != "OK") return 1;
                    string secret = encoding.GetString(Convert.FromBase64String(reader.ReadLine() ?? ""));
                    Console.OutputEncoding = encoding;
                    Console.WriteLine(secret);
                    return 0;
                }
            }
        } catch { return 1; }
    }
}
