using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using Unity.Profiling;
using UnityEngine;
using UnityEngine.Rendering;

namespace MythMaker.DynamicAssemblySpike
{
    /// <summary>Standalone allocation-stable instanced swarm benchmark over the real source meshes.</summary>
    public sealed class ReefSkitterSwarmBenchmark : MonoBehaviour
    {
        private const int CreatureCount = 400;
        private const int WarmupFrames = 120;
        private const int SampleFrames = 300;

        private ReefSkitterGlbRuntime asset;
        private readonly Vector4[] roots = new Vector4[CreatureCount];
        private readonly bool[] visible = new bool[CreatureCount];
        private readonly ReefSkitterAgentAnimation[] animations = new ReefSkitterAgentAnimation[CreatureCount];
        private readonly List<float> frameTimes = new List<float>(SampleFrames);
        private readonly List<float> cpuTimes = new List<float>(SampleFrames);
        private readonly List<float> gpuTimes = new List<float>(SampleFrames);
        private readonly List<long> drawCalls = new List<long>(SampleFrames);
        private readonly List<long> batches = new List<long>(SampleFrames);
        private readonly List<long> gcAllocated = new List<long>(SampleFrames);
        private readonly Plane[] frustum = new Plane[6];
        private readonly FrameTiming[] latestFrameTiming = new FrameTiming[1];
        private readonly Vector4[] visibleRoots = new Vector4[CreatureCount];
        private readonly Vector4[] visibleAnimation = new Vector4[CreatureCount];
        private readonly int[] visibleByLod = new int[3];
        private readonly int[] visibleByState = new int[5];
        private readonly int[] maxVisibleByLod = new int[3];
        private readonly int[] maxVisibleByState = new int[5];
        private readonly float[] nextAttackAt = new float[CreatureCount];
        private CommandBuffer drawBuffer;
        private ComputeBuffer rootBuffer, animationSelectorBuffer, animationSampleBuffer;
        private ComputeBuffer[] argumentBuffers;
        private readonly uint[] indirectArguments = new uint[5];
        private Camera benchmarkCamera;
        private GUIStyle titleStyle, bodyStyle;
        private readonly GUIContent statusContent = new GUIContent("Sampling shared animation workload");
        private ProfilerRecorder cpuRecorder, gpuRecorder, drawRecorder, batchRecorder, gcRecorder;
        private int frame, visibleCount, submittedDrawCalls, poseUpdatesThisFrame;
        private int visibleCountMinimum = int.MaxValue, visibleCountMaximum;
        private long poseUpdatesTotal, visibleCountTotal;
        private bool completed;
        private string sourcePath, outputRoot;

        private void Start()
        {
            Application.runInBackground = true;
            sourcePath = Environment.GetEnvironmentVariable("REEF_SKITTER_GLB_PATH");
            outputRoot = Environment.GetEnvironmentVariable("REEF_SKITTER_BENCHMARK_OUTPUT") ?? Path.Combine(Application.persistentDataPath, "reef-skitter-benchmark");
            asset = ReefSkitterGlbRuntime.Load(sourcePath);
            if (!asset.HasCompleteAnimationSet) throw new InvalidDataException("Benchmark input must be the integrated Reef Skitter GLB with all five shared part-track clips");
            InitializeAgents(); ConfigureScene(); ConfigureDrawBuffer(); StartRecorders(); Directory.CreateDirectory(outputRoot);
            Debug.Log($"[ReefSkitterBenchmark] ready source={sourcePath}; parts={asset.Parts.Count}; creatures={CreatureCount}; sourceAnimations={asset.SourceAnimationCount}");
        }

        private void InitializeAgents()
        {
            int side = Mathf.CeilToInt(Mathf.Sqrt(CreatureCount));
            for (int index = 0; index < CreatureCount; index++)
            {
                int x = index % side, z = index / side; uint seed = ReefSkitterSharedAnimationRuntime.Hash((uint)index + 1u);
                animations[index] = ReefSkitterSharedAnimationRuntime.Initialize(seed);
                nextAttackAt[index] = .5f + (seed & 0xffffu) / 65536f * 2f;
                roots[index] = new Vector4((x - side * .5f) * 1.18f, 0f, (z - side * .5f) * 1.18f, (seed % 360u) * Mathf.Deg2Rad);
            }
        }

        private void ConfigureScene()
        {
            QualitySettings.vSyncCount = 0; Application.targetFrameRate = -1;
            benchmarkCamera = new GameObject("Reef Skitter Swarm Camera").AddComponent<Camera>();
            benchmarkCamera.clearFlags = CameraClearFlags.SolidColor; benchmarkCamera.backgroundColor = new Color(.015f, .035f, .055f, 1f);
            benchmarkCamera.transform.position = new Vector3(0f, 17f, -25f); benchmarkCamera.transform.LookAt(Vector3.zero); benchmarkCamera.fieldOfView = 58f; benchmarkCamera.farClipPlane = 90f;
            Light key = new GameObject("Swarm Key Light").AddComponent<Light>(); key.type = LightType.Directional; key.intensity = 1.25f; key.transform.rotation = Quaternion.Euler(48f, -32f, 0f);
            RenderSettings.ambientMode = AmbientMode.Flat; RenderSettings.ambientLight = new Color(.22f, .32f, .4f);
        }

        private void StartRecorders()
        {
            cpuRecorder = ProfilerRecorder.StartNew(ProfilerCategory.Internal, "Main Thread");
            gpuRecorder = ProfilerRecorder.StartNew(ProfilerCategory.Render, "GPU Frame Time");
            drawRecorder = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Draw Calls Count");
            batchRecorder = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Batches Count");
            gcRecorder = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Allocated In Frame");
        }

        private void ConfigureDrawBuffer()
        {
            rootBuffer = new ComputeBuffer(CreatureCount, 16, ComputeBufferType.Structured);
            animationSelectorBuffer = new ComputeBuffer(CreatureCount, 16, ComputeBufferType.Structured);
            animationSampleBuffer = new ComputeBuffer(asset.BoneAnimationSamples.Length, 64, ComputeBufferType.Structured);
            animationSampleBuffer.SetData(asset.BoneAnimationSamples);
            argumentBuffers = new ComputeBuffer[asset.Parts.Count];
            drawBuffer = new CommandBuffer { name = "Reef Skitter Instanced Swarm" };
            benchmarkCamera.AddCommandBuffer(CameraEvent.BeforeForwardOpaque, drawBuffer);
            for (int partIndex = 0; partIndex < asset.Parts.Count; partIndex++)
            {
                ReefSkitterGlbRuntime.Part part = asset.Parts[partIndex];
                part.Material.SetBuffer("_InstanceRoots", rootBuffer); part.Material.SetBuffer("_InstanceAnimation", animationSelectorBuffer); part.Material.SetBuffer("_BoneAnimationSamples", animationSampleBuffer);
                part.Material.SetInt("_JointCount", asset.AnimationJointCount); part.Material.SetInt("_SamplesPerClip", asset.AnimationSamplesPerClip);
                indirectArguments[0] = part.Mesh.GetIndexCount(0); indirectArguments[1] = 0; indirectArguments[2] = part.Mesh.GetIndexStart(0); indirectArguments[3] = part.Mesh.GetBaseVertex(0); indirectArguments[4] = 0;
                argumentBuffers[partIndex] = new ComputeBuffer(1, indirectArguments.Length * sizeof(uint), ComputeBufferType.IndirectArguments); argumentBuffers[partIndex].SetData(indirectArguments);
            }
        }

        private void Update()
        {
            FrameTimingManager.CaptureFrameTimings();
            float time = Time.unscaledTime; GeometryUtility.CalculateFrustumPlanes(benchmarkCamera, frustum); visibleCount = 0; poseUpdatesThisFrame = 0;
            Array.Clear(visibleByLod, 0, visibleByLod.Length); Array.Clear(visibleByState, 0, visibleByState.Length);
            for (int index = 0; index < CreatureCount; index++)
            {
                Vector3 position = new Vector3(roots[index].x, roots[index].y, roots[index].z); float distance = Vector3.Distance(position, benchmarkCamera.transform.position);
                Bounds worldBounds = new Bounds(position + Vector3.up * asset.Bounds.center.y, asset.Bounds.size);
                bool isVisible = distance <= ReefSkitterSharedAnimationRuntime.CullDistance && GeometryUtility.TestPlanesAABB(frustum, worldBounds); visible[index] = isVisible;
                if (!isVisible) continue; visibleCount++;
                ReefSkitterAgentAnimation animation = animations[index]; byte lod = ReefSkitterSharedAnimationRuntime.SelectLod(distance);
                if (animation.Lod != lod) { animation.Lod = lod; animation.NextUpdateTime = time; }
                if (animation.Seed % 5u == 3u && animation.State == ReefSkitterAnimationState.Idle && time >= nextAttackAt[index])
                {
                    animation.State = ReefSkitterAnimationState.Attack; animation.Phase = 0f; animation.LastUpdateTime = time; animation.NextUpdateTime = time;
                    nextAttackAt[index] = time + 2.5f + (animation.Seed & 0xffu) / 255f;
                }
                if (ReefSkitterSharedAnimationRuntime.Advance(ref animation, time, asset.AnimationClipDurations)) { poseUpdatesThisFrame++; poseUpdatesTotal++; }
                animations[index] = animation; visibleByLod[lod]++; visibleByState[(int)animation.State]++;
                visibleRoots[visibleCount - 1] = roots[index]; visibleAnimation[visibleCount - 1] = new Vector4((float)animation.State, animation.Phase, animation.Lod, 0f);
            }
            for (int index = 0; index < visibleByLod.Length; index++) maxVisibleByLod[index] = Mathf.Max(maxVisibleByLod[index], visibleByLod[index]);
            for (int index = 0; index < visibleByState.Length; index++) maxVisibleByState[index] = Mathf.Max(maxVisibleByState[index], visibleByState[index]);

            if (visibleCount > 0) { rootBuffer.SetData(visibleRoots, 0, 0, visibleCount); animationSelectorBuffer.SetData(visibleAnimation, 0, 0, visibleCount); }
            submittedDrawCalls = 0; drawBuffer.Clear();
            for (int partIndex = 0; partIndex < asset.Parts.Count; partIndex++)
            {
                ReefSkitterGlbRuntime.Part part = asset.Parts[partIndex];
                indirectArguments[0] = part.Mesh.GetIndexCount(0); indirectArguments[1] = (uint)visibleCount; indirectArguments[2] = part.Mesh.GetIndexStart(0); indirectArguments[3] = part.Mesh.GetBaseVertex(0); indirectArguments[4] = 0;
                argumentBuffers[partIndex].SetData(indirectArguments);
                if (visibleCount > 0) { drawBuffer.DrawMeshInstancedIndirect(part.Mesh, 0, part.Material, 0, argumentBuffers[partIndex]); submittedDrawCalls++; }
            }

            frame++; if (frame > WarmupFrames && !completed) RecordFrame();
            if (frame == WarmupFrames + SampleFrames) CompleteBenchmark();
        }

        private void RecordFrame()
        {
            frameTimes.Add(Time.unscaledDeltaTime * 1000f);
            if (cpuRecorder.Valid) cpuTimes.Add(cpuRecorder.LastValue / 1000000f);
            if (gpuRecorder.Valid && gpuRecorder.LastValue > 0) gpuTimes.Add(gpuRecorder.LastValue / 1000000f);
            else if (FrameTimingManager.GetLatestTimings(1, latestFrameTiming) > 0 && latestFrameTiming[0].gpuFrameTime > 0) gpuTimes.Add((float)latestFrameTiming[0].gpuFrameTime);
            if (drawRecorder.Valid) drawCalls.Add(drawRecorder.LastValue);
            if (batchRecorder.Valid) batches.Add(batchRecorder.LastValue);
            if (gcRecorder.Valid) gcAllocated.Add(gcRecorder.LastValue);
            visibleCountMinimum = Mathf.Min(visibleCountMinimum, visibleCount); visibleCountMaximum = Mathf.Max(visibleCountMaximum, visibleCount); visibleCountTotal += visibleCount;
        }

        private void CompleteBenchmark()
        {
            completed = true; statusContent.text = "BENCHMARK RECEIPT WRITTEN"; string screenshot = Path.Combine(outputRoot, "reef-skitter-swarm.png"); RenderScreenshot(screenshot);
            BenchmarkReceipt receipt = new BenchmarkReceipt
            {
                receipt_kind = "reef_skitter_swarm_benchmark.v1", captured_at = DateTime.UtcNow.ToString("O"), runtime = Application.unityVersion,
                graphics_api = SystemInfo.graphicsDeviceType.ToString(), graphics_device = SystemInfo.graphicsDeviceName,
                source_path = sourcePath, source_sha256 = Sha256(File.ReadAllBytes(sourcePath)), source_part_count = asset.Parts.Count, source_animation_count = asset.SourceAnimationCount,
                creatures_requested = CreatureCount, creatures_visible = visibleCount, sample_frames = frameTimes.Count,
                creatures_visible_minimum = visibleCountMinimum == int.MaxValue ? 0 : visibleCountMinimum, creatures_visible_maximum = visibleCountMaximum,
                creatures_visible_average = frameTimes.Count == 0 ? 0f : visibleCountTotal / (float)frameTimes.Count,
                frame_ms_average = Average(frameTimes), frame_ms_p95 = Percentile(frameTimes, .95f), cpu_main_thread_ms_average = Average(cpuTimes), gpu_ms_average = Average(gpuTimes),
                memory_allocated_bytes = UnityEngine.Profiling.Profiler.GetTotalAllocatedMemoryLong(), draw_calls_counter_average = PositiveAverage(drawCalls), batches_counter_average = PositiveAverage(batches),
                gc_allocated_bytes_per_frame_average = Average(gcAllocated),
                submitted_instanced_draw_calls = submittedDrawCalls, submitted_batch_groups = submittedDrawCalls, per_agent_animator_count = 0, screenshot = Path.GetFileName(screenshot),
                animation_clip_count = asset.AnimationClipNames.Count, animation_joint_count = asset.AnimationJointCount, animation_samples_per_clip = asset.AnimationSamplesPerClip, shared_animation_buffer_bytes = asset.BoneAnimationSamples.Length * 64,
                per_agent_state_contract_bytes = ReefSkitterSharedAnimationRuntime.AgentContractBytes, pose_updates_total = poseUpdatesTotal,
                visible_instance_upload_bytes = visibleCount * ReefSkitterSharedAnimationRuntime.AgentContractBytes,
                lod0_visible = visibleByLod[0], lod1_visible = visibleByLod[1], lod2_visible = visibleByLod[2],
                idle_visible = visibleByState[0], walk_visible = visibleByState[1], run_visible = visibleByState[2], attack_visible = visibleByState[3], death_visible = visibleByState[4],
                lod0_visible_max = maxVisibleByLod[0], lod1_visible_max = maxVisibleByLod[1], lod2_visible_max = maxVisibleByLod[2],
                idle_visible_max = maxVisibleByState[0], walk_visible_max = maxVisibleByState[1], run_visible_max = maxVisibleByState[2], attack_visible_max = maxVisibleByState[3], death_visible_max = maxVisibleByState[4],
                evidence_scope = "Standalone player over the integrated skinned Reef Skitter GLB. The shader samples one shared five-clip bone-matrix library for 400 compact deterministic agents while preserving 15 provider part/material draw groups; there are no per-agent Animator components."
            };
            string receiptPath = Path.Combine(outputRoot, "reef-skitter-swarm-benchmark.json"); File.WriteAllText(receiptPath, JsonUtility.ToJson(receipt, true));
            Debug.Log($"[ReefSkitterBenchmark] complete receipt={receiptPath}; visible={visibleCount}; frame_avg_ms={receipt.frame_ms_average:F3}; cpu_ms={receipt.cpu_main_thread_ms_average:F3}; gpu_ms={receipt.gpu_ms_average:F3}; draws={receipt.draw_calls_counter_average:F1}; batches={receipt.batches_counter_average:F1}");
            if (Environment.GetEnvironmentVariable("REEF_SKITTER_BENCHMARK_AUTORUN") == "1") Invoke(nameof(Quit), 1f);
        }

        private void RenderScreenshot(string path)
        {
            RenderTexture texture = new RenderTexture(1600, 900, 24, RenderTextureFormat.ARGB32);
            RenderTexture previous = RenderTexture.active; benchmarkCamera.targetTexture = texture; benchmarkCamera.Render(); RenderTexture.active = texture;
            Texture2D image = new Texture2D(1600, 900, TextureFormat.RGBA32, false); image.ReadPixels(new Rect(0, 0, 1600, 900), 0, 0); image.Apply(); File.WriteAllBytes(path, image.EncodeToPNG());
            benchmarkCamera.targetTexture = null; RenderTexture.active = previous; Destroy(image); Destroy(texture);
        }

        private void OnGUI()
        {
            if (titleStyle == null)
            {
                titleStyle = new GUIStyle(GUI.skin.label) { fontSize = 26, fontStyle = FontStyle.Bold }; titleStyle.normal.textColor = Color.white;
                bodyStyle = new GUIStyle(GUI.skin.label) { fontSize = 17 }; bodyStyle.normal.textColor = new Color(.65f, .96f, .94f);
            }
            GUI.Box(new Rect(24, 24, 550, 128), GUIContent.none); GUI.Label(new Rect(44, 38, 510, 36), "REEF SKITTER · INSTANCED SWARM", titleStyle);
            GUI.Label(new Rect(44, 80, 510, 28), "400 agents · 5 shared clips · Animator 0", bodyStyle);
            GUI.Label(new Rect(44, 110, 510, 28), statusContent, bodyStyle);
        }

        private void Quit() => Application.Quit(0);
        private void OnDestroy() { if (benchmarkCamera != null && drawBuffer != null) benchmarkCamera.RemoveCommandBuffer(CameraEvent.BeforeForwardOpaque, drawBuffer); drawBuffer?.Dispose(); rootBuffer?.Dispose(); animationSelectorBuffer?.Dispose(); animationSampleBuffer?.Dispose(); if (argumentBuffers != null) foreach (ComputeBuffer buffer in argumentBuffers) buffer?.Dispose(); cpuRecorder.Dispose(); gpuRecorder.Dispose(); drawRecorder.Dispose(); batchRecorder.Dispose(); gcRecorder.Dispose(); asset?.Dispose(); }
        private static float Average(List<float> values) { if (values.Count == 0) return -1f; double total = 0; foreach (float value in values) total += value; return (float)(total / values.Count); }
        private static float Average(List<long> values) { if (values.Count == 0) return -1f; double total = 0; foreach (long value in values) total += value; return (float)(total / values.Count); }
        private static float PositiveAverage(List<long> values) { float average = Average(values); return average > 0f ? average : -1f; }
        private static float Percentile(List<float> values, float percentile) { if (values.Count == 0) return -1f; float[] copy = values.ToArray(); Array.Sort(copy); return copy[Mathf.Clamp(Mathf.CeilToInt(copy.Length * percentile) - 1, 0, copy.Length - 1)]; }
        private static string Sha256(byte[] bytes) { using SHA256 hash = SHA256.Create(); return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", string.Empty).ToLowerInvariant(); }

        [Serializable] private sealed class BenchmarkReceipt
        {
            public string receipt_kind, captured_at, runtime, graphics_api, graphics_device, source_path, source_sha256, screenshot, evidence_scope;
            public int source_part_count, source_animation_count, creatures_requested, creatures_visible, creatures_visible_minimum, creatures_visible_maximum, sample_frames, submitted_instanced_draw_calls, submitted_batch_groups, per_agent_animator_count;
            public int animation_clip_count, animation_joint_count, animation_samples_per_clip, shared_animation_buffer_bytes, per_agent_state_contract_bytes, visible_instance_upload_bytes, lod0_visible, lod1_visible, lod2_visible, idle_visible, walk_visible, run_visible, attack_visible, death_visible;
            public int lod0_visible_max, lod1_visible_max, lod2_visible_max, idle_visible_max, walk_visible_max, run_visible_max, attack_visible_max, death_visible_max;
            public long pose_updates_total;
            public float creatures_visible_average, frame_ms_average, frame_ms_p95, cpu_main_thread_ms_average, gpu_ms_average, draw_calls_counter_average, batches_counter_average, gc_allocated_bytes_per_frame_average;
            public long memory_allocated_bytes;
        }
    }
}
