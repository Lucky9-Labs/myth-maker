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
        private const float CullDistance = 48f;

        private ReefSkitterGlbRuntime asset;
        private readonly Matrix4x4[] roots = new Matrix4x4[CreatureCount];
        private readonly bool[] visible = new bool[CreatureCount];
        private readonly float[] phases = new float[CreatureCount];
        private readonly byte[] states = new byte[CreatureCount];
        private readonly List<float> frameTimes = new List<float>(SampleFrames);
        private readonly List<float> cpuTimes = new List<float>(SampleFrames);
        private readonly List<float> gpuTimes = new List<float>(SampleFrames);
        private readonly List<long> drawCalls = new List<long>(SampleFrames);
        private readonly List<long> batches = new List<long>(SampleFrames);
        private readonly Plane[] frustum = new Plane[6];
        private readonly FrameTiming[] latestFrameTiming = new FrameTiming[1];
        private readonly Matrix4x4[] visibleRoots = new Matrix4x4[CreatureCount];
        private CommandBuffer drawBuffer;
        private ComputeBuffer rootBuffer;
        private ComputeBuffer[] argumentBuffers;
        private readonly uint[] indirectArguments = new uint[5];
        private Camera benchmarkCamera;
        private ProfilerRecorder cpuRecorder, gpuRecorder, drawRecorder, batchRecorder;
        private int frame, visibleCount, submittedDrawCalls;
        private bool completed;
        private string sourcePath, outputRoot;

        private void Start()
        {
            Application.runInBackground = true;
            sourcePath = Environment.GetEnvironmentVariable("REEF_SKITTER_GLB_PATH");
            outputRoot = Environment.GetEnvironmentVariable("REEF_SKITTER_BENCHMARK_OUTPUT") ?? Path.Combine(Application.persistentDataPath, "reef-skitter-benchmark");
            asset = ReefSkitterGlbRuntime.Load(sourcePath);
            InitializeAgents(); ConfigureScene(); ConfigureDrawBuffer(); StartRecorders(); Directory.CreateDirectory(outputRoot);
            Debug.Log($"[ReefSkitterBenchmark] ready source={sourcePath}; parts={asset.Parts.Count}; creatures={CreatureCount}; sourceAnimations={asset.SourceAnimationCount}");
        }

        private void InitializeAgents()
        {
            int side = Mathf.CeilToInt(Mathf.Sqrt(CreatureCount));
            for (int index = 0; index < CreatureCount; index++)
            {
                int x = index % side, z = index / side; uint seed = Hash((uint)index + 1u);
                phases[index] = (seed & 0xffffu) / 65536f; states[index] = (byte)(seed % 5u);
                roots[index] = Matrix4x4.TRS(new Vector3((x - side * .5f) * 1.18f, 0f, (z - side * .5f) * 1.18f), Quaternion.Euler(0f, seed % 360u, 0f), Vector3.one);
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
        }

        private void ConfigureDrawBuffer()
        {
            rootBuffer = new ComputeBuffer(CreatureCount, 64, ComputeBufferType.Structured);
            argumentBuffers = new ComputeBuffer[asset.Parts.Count];
            drawBuffer = new CommandBuffer { name = "Reef Skitter Instanced Swarm" };
            benchmarkCamera.AddCommandBuffer(CameraEvent.BeforeForwardOpaque, drawBuffer);
            for (int partIndex = 0; partIndex < asset.Parts.Count; partIndex++)
            {
                ReefSkitterGlbRuntime.Part part = asset.Parts[partIndex]; part.Material.SetBuffer("_InstanceMatrices", rootBuffer); part.Material.SetMatrix("_PartMatrix", part.LocalMatrix);
                indirectArguments[0] = part.Mesh.GetIndexCount(0); indirectArguments[1] = 0; indirectArguments[2] = part.Mesh.GetIndexStart(0); indirectArguments[3] = part.Mesh.GetBaseVertex(0); indirectArguments[4] = 0;
                argumentBuffers[partIndex] = new ComputeBuffer(1, indirectArguments.Length * sizeof(uint), ComputeBufferType.IndirectArguments); argumentBuffers[partIndex].SetData(indirectArguments);
            }
        }

        private void Update()
        {
            FrameTimingManager.CaptureFrameTimings();
            float time = Time.unscaledTime; GeometryUtility.CalculateFrustumPlanes(benchmarkCamera, frustum); visibleCount = 0;
            for (int index = 0; index < CreatureCount; index++)
            {
                Vector3 position = roots[index].GetColumn(3); float distance = Vector3.Distance(position, benchmarkCamera.transform.position);
                Bounds worldBounds = new Bounds(position + Vector3.up * asset.Bounds.center.y, asset.Bounds.size);
                bool isVisible = distance <= CullDistance && GeometryUtility.TestPlanesAABB(frustum, worldBounds); visible[index] = isVisible;
                if (!isVisible) continue; visibleCount++;
                // The source has no authored clips. This small deterministic offset exercises only compact state/instance updates.
                float phase = phases[index] * Mathf.PI * 2f; position.y = Mathf.Sin(time * (1.6f + states[index] * .42f) + phase) * .025f;
                roots[index] = Matrix4x4.TRS(position, roots[index].rotation, Vector3.one); visibleRoots[visibleCount - 1] = roots[index];
            }

            if (visibleCount > 0) rootBuffer.SetData(visibleRoots, 0, 0, visibleCount);
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
        }

        private void CompleteBenchmark()
        {
            completed = true; string screenshot = Path.Combine(outputRoot, "reef-skitter-swarm.png"); RenderScreenshot(screenshot);
            BenchmarkReceipt receipt = new BenchmarkReceipt
            {
                receipt_kind = "reef_skitter_swarm_benchmark.v1", captured_at = DateTime.UtcNow.ToString("O"), runtime = Application.unityVersion,
                graphics_api = SystemInfo.graphicsDeviceType.ToString(), graphics_device = SystemInfo.graphicsDeviceName,
                source_path = sourcePath, source_sha256 = Sha256(File.ReadAllBytes(sourcePath)), source_part_count = asset.Parts.Count, source_animation_count = asset.SourceAnimationCount,
                creatures_requested = CreatureCount, creatures_visible = visibleCount, sample_frames = frameTimes.Count,
                frame_ms_average = Average(frameTimes), frame_ms_p95 = Percentile(frameTimes, .95f), cpu_main_thread_ms_average = Average(cpuTimes), gpu_ms_average = Average(gpuTimes),
                memory_allocated_bytes = UnityEngine.Profiling.Profiler.GetTotalAllocatedMemoryLong(), draw_calls_counter_average = PositiveAverage(drawCalls), batches_counter_average = PositiveAverage(batches),
                submitted_instanced_draw_calls = submittedDrawCalls, submitted_batch_groups = submittedDrawCalls, per_agent_animator_count = 0, screenshot = Path.GetFileName(screenshot),
                evidence_scope = "Standalone macOS development player over real Reef Skitter GLB meshes. Source contains no authored clips; deterministic bob only exercises the instanced state/update path."
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
            GUIStyle title = new GUIStyle(GUI.skin.label) { fontSize = 26, fontStyle = FontStyle.Bold, normal = { textColor = Color.white } };
            GUIStyle body = new GUIStyle(GUI.skin.label) { fontSize = 17, normal = { textColor = new Color(.65f, .96f, .94f) } };
            GUI.Box(new Rect(24, 24, 550, 128), GUIContent.none); GUI.Label(new Rect(44, 38, 510, 36), "REEF SKITTER · INSTANCED SWARM", title);
            GUI.Label(new Rect(44, 80, 510, 28), $"Visible {visibleCount}/{CreatureCount}  ·  Parts {asset?.Parts.Count ?? 0}  ·  Animator 0", body);
            GUI.Label(new Rect(44, 110, 510, 28), completed ? "BENCHMARK RECEIPT WRITTEN" : $"Sampling frame {Mathf.Max(0, frame - WarmupFrames)}/{SampleFrames}", body);
        }

        private void Quit() => Application.Quit(0);
        private void OnDestroy() { if (benchmarkCamera != null && drawBuffer != null) benchmarkCamera.RemoveCommandBuffer(CameraEvent.BeforeForwardOpaque, drawBuffer); drawBuffer?.Dispose(); rootBuffer?.Dispose(); if (argumentBuffers != null) foreach (ComputeBuffer buffer in argumentBuffers) buffer?.Dispose(); cpuRecorder.Dispose(); gpuRecorder.Dispose(); drawRecorder.Dispose(); batchRecorder.Dispose(); asset?.Dispose(); }
        private static uint Hash(uint value) { value = (value ^ (value >> 16)) * 0x45d9f3bu; value = (value ^ (value >> 16)) * 0x45d9f3bu; return value ^ (value >> 16); }
        private static float Average(List<float> values) { if (values.Count == 0) return -1f; double total = 0; foreach (float value in values) total += value; return (float)(total / values.Count); }
        private static float Average(List<long> values) { if (values.Count == 0) return -1f; double total = 0; foreach (long value in values) total += value; return (float)(total / values.Count); }
        private static float PositiveAverage(List<long> values) { float average = Average(values); return average > 0f ? average : -1f; }
        private static float Percentile(List<float> values, float percentile) { if (values.Count == 0) return -1f; float[] copy = values.ToArray(); Array.Sort(copy); return copy[Mathf.Clamp(Mathf.CeilToInt(copy.Length * percentile) - 1, 0, copy.Length - 1)]; }
        private static string Sha256(byte[] bytes) { using SHA256 hash = SHA256.Create(); return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", string.Empty).ToLowerInvariant(); }

        [Serializable] private sealed class BenchmarkReceipt
        {
            public string receipt_kind, captured_at, runtime, graphics_api, graphics_device, source_path, source_sha256, screenshot, evidence_scope;
            public int source_part_count, source_animation_count, creatures_requested, creatures_visible, sample_frames, submitted_instanced_draw_calls, submitted_batch_groups, per_agent_animator_count;
            public float frame_ms_average, frame_ms_p95, cpu_main_thread_ms_average, gpu_ms_average, draw_calls_counter_average, batches_counter_average;
            public long memory_allocated_bytes;
        }
    }
}
