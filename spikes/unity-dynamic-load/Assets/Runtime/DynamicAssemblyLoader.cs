using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;

namespace MythMaker.DynamicAssemblySpike
{
    public enum DynamicAssemblyLoadStatus
    {
        MissingArtifact,
        MissingOrInvalidHash,
        HashMismatch,
        InvalidAssembly,
        MissingEntrypointType,
        MissingEntrypointMethod,
        InvalidEntrypoint,
        InvocationFailed,
        Loaded
    }

    public readonly struct DynamicAssemblyReceipt
    {
        public DynamicAssemblyReceipt(DynamicAssemblyLoadStatus status, string message, string sha256 = null, string entrypoint = null)
        {
            Status = status;
            Message = message;
            Sha256 = sha256;
            Entrypoint = entrypoint;
        }

        public DynamicAssemblyLoadStatus Status { get; }
        public string Message { get; }
        public string Sha256 { get; }
        public string Entrypoint { get; }
    }

    public static class DynamicAssemblyLoader
    {
        public static bool TryLoad(byte[] assemblyBytes, string entrypointType, string entrypointMethod, out DynamicAssemblyReceipt receipt, string expectedSha256 = null)
        {
            if (assemblyBytes == null || assemblyBytes.Length == 0)
            {
                receipt = new DynamicAssemblyReceipt(DynamicAssemblyLoadStatus.MissingArtifact, "No assembly bytes were supplied.");
                return false;
            }

            string sha256 = ComputeSha256(assemblyBytes);
            if (!IsSha256(expectedSha256))
            {
                receipt = new DynamicAssemblyReceipt(DynamicAssemblyLoadStatus.MissingOrInvalidHash, "A 64-character SHA-256 is required before an assembly can load.", sha256);
                return false;
            }
            if (!string.Equals(expectedSha256, sha256, StringComparison.OrdinalIgnoreCase))
            {
                receipt = new DynamicAssemblyReceipt(DynamicAssemblyLoadStatus.HashMismatch, "The supplied SHA-256 does not match the assembly bytes.", sha256);
                return false;
            }

            Assembly assembly;
            try
            {
                assembly = Assembly.Load(assemblyBytes);
            }
            catch (Exception exception) when (exception is BadImageFormatException || exception is FileLoadException || exception is FileNotFoundException || exception is TypeLoadException)
            {
                receipt = new DynamicAssemblyReceipt(DynamicAssemblyLoadStatus.InvalidAssembly, exception.GetType().Name + ": " + exception.Message, sha256);
                return false;
            }

            Type type = assembly.GetType(entrypointType, false);
            if (type == null)
            {
                receipt = new DynamicAssemblyReceipt(DynamicAssemblyLoadStatus.MissingEntrypointType, "Entrypoint type was not found: " + entrypointType, sha256);
                return false;
            }

            MethodInfo method = type.GetMethod(entrypointMethod, BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
            if (method == null)
            {
                receipt = new DynamicAssemblyReceipt(DynamicAssemblyLoadStatus.MissingEntrypointMethod, "Public static parameterless entrypoint was not found: " + entrypointMethod, sha256, type.FullName);
                return false;
            }
            if (method.ReturnType != typeof(string))
            {
                receipt = new DynamicAssemblyReceipt(DynamicAssemblyLoadStatus.InvalidEntrypoint, "Entrypoint must return a string.", sha256, type.FullName + "." + method.Name);
                return false;
            }

            try
            {
                string description = (string)method.Invoke(null, null);
                receipt = new DynamicAssemblyReceipt(DynamicAssemblyLoadStatus.Loaded, description, sha256, type.FullName + "." + method.Name);
                return true;
            }
            catch (TargetInvocationException exception)
            {
                receipt = new DynamicAssemblyReceipt(DynamicAssemblyLoadStatus.InvocationFailed, exception.InnerException?.GetType().Name + ": " + exception.InnerException?.Message, sha256, type.FullName + "." + method.Name);
                return false;
            }
        }

        public static string ComputeSha256(byte[] bytes)
        {
            using SHA256 hash = SHA256.Create();
            byte[] digest = hash.ComputeHash(bytes);
            return BitConverter.ToString(digest).Replace("-", string.Empty).ToLowerInvariant();
        }

        private static bool IsSha256(string value)
        {
            if (value == null || value.Length != 64) return false;
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')))
                {
                    return false;
                }
            }
            return true;
        }
    }
}
