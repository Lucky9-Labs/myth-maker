using UnityEngine;

namespace MythMaker.DynamicAssemblySpike
{
    public enum ReefSkitterAnimationState : byte { Idle, Walk, Run, Attack, Death }

    /// <summary>Compact deterministic state advanced at an explicit distance-based cadence.</summary>
    public struct ReefSkitterAgentAnimation
    {
        public ReefSkitterAnimationState State;
        public float Phase;
        public float LastUpdateTime;
        public float NextUpdateTime;
        public uint Seed;
        public byte Lod;
    }

    public static class ReefSkitterSharedAnimationRuntime
    {
        public const int AgentContractBytes = 32;
        public const float NearDistance = 20f;
        public const float MidDistance = 55f;
        public const float CullDistance = 80f;

        public static ReefSkitterAgentAnimation Initialize(uint seed)
        {
            return new ReefSkitterAgentAnimation
            {
                State = (ReefSkitterAnimationState)(seed % 5u),
                Phase = (seed & 0xffffu) / 65536f,
                Seed = seed,
                LastUpdateTime = 0f,
                NextUpdateTime = 0f,
                Lod = 0
            };
        }

        public static byte SelectLod(float distance)
        {
            if (distance <= NearDistance) return 0;
            if (distance <= MidDistance) return 1;
            return 2;
        }

        public static float UpdateInterval(byte lod) => lod == 0 ? 1f / 30f : lod == 1 ? 1f / 10f : float.PositiveInfinity;

        /// <summary>Returns true only when the shared GPU pose selector needs uploading.</summary>
        public static bool Advance(ref ReefSkitterAgentAnimation animation, float now, float[] clipDurations)
        {
            if (clipDurations == null || clipDurations.Length != 5) return false;
            float interval = UpdateInterval(animation.Lod);
            if (float.IsInfinity(interval) || now < animation.NextUpdateTime) return false;
            float elapsed = Mathf.Max(0f, now - animation.LastUpdateTime);
            float duration = Mathf.Max(.001f, clipDurations[(int)animation.State]);
            float speedJitter = .94f + HashUnit(animation.Seed ^ (uint)animation.State) * .12f;
            float next = animation.Phase + elapsed * speedJitter / duration;
            if (animation.State == ReefSkitterAnimationState.Death) animation.Phase = Mathf.Min(1f, next);
            else if (animation.State == ReefSkitterAnimationState.Attack && next >= 1f) { animation.State = ReefSkitterAnimationState.Idle; animation.Phase = 0f; }
            else animation.Phase = next - Mathf.Floor(next);
            animation.LastUpdateTime = now;
            animation.NextUpdateTime = now + interval;
            return true;
        }

        public static uint Hash(uint value)
        {
            value = (value ^ (value >> 16)) * 0x45d9f3bu;
            value = (value ^ (value >> 16)) * 0x45d9f3bu;
            return value ^ (value >> 16);
        }

        private static float HashUnit(uint value) => Hash(value) / 4294967296f;
    }
}
