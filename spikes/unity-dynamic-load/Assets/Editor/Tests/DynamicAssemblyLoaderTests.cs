using NUnit.Framework;
using UnityEngine;

namespace MythMaker.DynamicAssemblySpike.Tests
{
    public sealed class DynamicAssemblyLoaderTests
    {
        [Test]
        public void NullBytesAreRejectedWithoutThrowing()
        {
            bool loaded = DynamicAssemblyLoader.TryLoad(null, "fixture.DynamicProbe", "Describe", out DynamicAssemblyReceipt receipt, new string('0', 64));

            Assert.That(loaded, Is.False);
            Assert.That(receipt.Status, Is.EqualTo(DynamicAssemblyLoadStatus.MissingArtifact));
            Assert.That(receipt.Message, Does.Contain("No assembly bytes"));
        }

        [Test]
        public void ExternalFixtureBytesLoadAndExecuteTheDeclaredEntrypoint()
        {
            TextAsset fixture = Resources.Load<TextAsset>("DynamicPluginFixture");

            bool loaded = DynamicAssemblyLoader.TryLoad(fixture.bytes, "fixture.DynamicProbe", "Describe", out DynamicAssemblyReceipt receipt, DynamicAssemblyLoader.ComputeSha256(fixture.bytes));

            Assert.That(loaded, Is.True, receipt.Message);
            Assert.That(receipt.Status, Is.EqualTo(DynamicAssemblyLoadStatus.Loaded));
            Assert.That(receipt.Message, Is.EqualTo("External assembly executed: DynamicProbe.Describe"));
            Assert.That(receipt.Sha256, Has.Length.EqualTo(64));
        }

        [Test]
        public void IncorrectHashRejectsBytesBeforeAssemblyLoading()
        {
            bool loaded = DynamicAssemblyLoader.TryLoad(new byte[] { 1, 2, 3 }, "fixture.DynamicProbe", "Describe", out DynamicAssemblyReceipt receipt, new string('0', 64));

            Assert.That(loaded, Is.False);
            Assert.That(receipt.Status, Is.EqualTo(DynamicAssemblyLoadStatus.HashMismatch));
        }

        [Test]
        public void MissingHashRejectsBytesBeforeAssemblyLoading()
        {
            bool loaded = DynamicAssemblyLoader.TryLoad(new byte[] { 1, 2, 3 }, "fixture.DynamicProbe", "Describe", out DynamicAssemblyReceipt receipt);

            Assert.That(loaded, Is.False);
            Assert.That(receipt.Status, Is.EqualTo(DynamicAssemblyLoadStatus.MissingOrInvalidHash));
        }
    }
}
