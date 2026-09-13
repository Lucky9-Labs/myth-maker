using System.IO;
using NUnit.Framework;
using UnityEngine;

namespace MythMaker.DynamicAssemblySpike.Tests
{
    public sealed class ReefSkitterGlbRuntimeTests
    {
        [Test]
        public void LoadsRepresentativePartedSourceWithoutSegmentation()
        {
            string repoRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "../../.."));
            string source = Path.Combine(repoRoot, "assets/reef-skitter/source/reef_skitter.tripo.glb");

            using ReefSkitterGlbRuntime runtime = ReefSkitterGlbRuntime.Load(source);

            Assert.That(runtime.Generator, Is.EqualTo("Tripo"));
            Assert.That(runtime.Parts, Has.Count.EqualTo(15));
            Assert.That(runtime.SourceAnimationCount, Is.EqualTo(0));
            Assert.That(runtime.Bounds.size.x, Is.GreaterThan(.99f));
            Assert.That(runtime.Parts[0].Material.enableInstancing, Is.True);
        }
    }
}
