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
            Assert.That(runtime.HasCompleteAnimationSet, Is.False);
            Assert.That(runtime.AnimationJointCount, Is.Zero);
            Assert.That(runtime.Bounds.size.x, Is.GreaterThan(.99f));
            Assert.That(runtime.Parts[0].Material.enableInstancing, Is.True);
        }

        [Test]
        public void CompactAnimationStateUsesDeterministicVariationAndLodCadence()
        {
            uint seed = ReefSkitterSharedAnimationRuntime.Hash(17u);
            ReefSkitterAgentAnimation first = ReefSkitterSharedAnimationRuntime.Initialize(seed);
            ReefSkitterAgentAnimation second = ReefSkitterSharedAnimationRuntime.Initialize(seed);
            float[] durations = { 2f, 1f, .5f, .75f, 1.5f };

            Assert.That(first.State, Is.EqualTo(second.State));
            Assert.That(first.Phase, Is.EqualTo(second.Phase));
            Assert.That(ReefSkitterSharedAnimationRuntime.SelectLod(19.9f), Is.EqualTo(0));
            Assert.That(ReefSkitterSharedAnimationRuntime.SelectLod(20.1f), Is.EqualTo(1));
            Assert.That(ReefSkitterSharedAnimationRuntime.SelectLod(55.1f), Is.EqualTo(2));
            Assert.That(ReefSkitterSharedAnimationRuntime.AgentContractBytes, Is.EqualTo(32));

            first.Lod = 0;
            Assert.That(ReefSkitterSharedAnimationRuntime.Advance(ref first, .1f, durations), Is.True);
            float advancedPhase = first.Phase;
            Assert.That(ReefSkitterSharedAnimationRuntime.Advance(ref first, .11f, durations), Is.False);
            Assert.That(first.Phase, Is.EqualTo(advancedPhase));

            first.Lod = 2; first.NextUpdateTime = 0f;
            Assert.That(ReefSkitterSharedAnimationRuntime.Advance(ref first, 10f, durations), Is.False);
        }

        [Test]
        public void AttackReturnsToIdleAndDeathFreezesAtEnd()
        {
            float[] durations = { 1f, 1f, 1f, .25f, .5f };
            ReefSkitterAgentAnimation attack = ReefSkitterSharedAnimationRuntime.Initialize(1u);
            attack.State = ReefSkitterAnimationState.Attack; attack.Phase = 0f;
            ReefSkitterSharedAnimationRuntime.Advance(ref attack, .3f, durations);
            Assert.That(attack.State, Is.EqualTo(ReefSkitterAnimationState.Idle));
            Assert.That(attack.Phase, Is.Zero);

            ReefSkitterAgentAnimation death = ReefSkitterSharedAnimationRuntime.Initialize(2u);
            death.State = ReefSkitterAnimationState.Death; death.Phase = 0f;
            ReefSkitterSharedAnimationRuntime.Advance(ref death, 2f, durations);
            Assert.That(death.State, Is.EqualTo(ReefSkitterAnimationState.Death));
            Assert.That(death.Phase, Is.EqualTo(1f));
        }
    }
}
