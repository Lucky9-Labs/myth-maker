using System;
using System.IO;
using System.Security.Cryptography;
using UnityEditor;
using UnityEngine;

namespace MythMaker.DynamicAssemblySpike.Editor
{
    /// <summary>
    /// Bounded, editor-only renderer for the exact accepted Build Room GLB.
    /// It does not claim a player import pipeline: it decodes only the glTF 2.0
    /// features present in the receipt and records Unity-rendered animation frames.
    /// </summary>
    public static class KrakenGlbCapture
    {
        private const int GlbMagic = 0x46546C67;
        private const int JsonChunk = 0x4E4F534A;
        private const int BinaryChunk = 0x004E4942;

        [MenuItem("Myth Maker/Capture accepted Kraken GLB")]
        public static void CaptureAcceptedKraken()
        {
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "../../.."));
            string glbPath = Environment.GetEnvironmentVariable("KRAKEN_GLB_PATH") ?? Path.Combine(projectRoot, "evidence/build-room-kraken-high-fanout-stress.json.artifacts/261fc2b0-1cf2-4a17-8d1f-b10b97b8ff42/wg-8340e6fcb9c609d3ddc8281669373364/runtime/737cff2c5eff32728e03c6c3de46fe82dcf3027bb92c1abf133cf63f7d177e94.glb");
            string outputRoot = Environment.GetEnvironmentVariable("KRAKEN_UNITY_CAPTURE_DIR") ?? Path.Combine(projectRoot, "evidence/unity-kraken-glb-capture");
            if (!File.Exists(glbPath)) throw new FileNotFoundException("Accepted Build Room GLB was not found", glbPath);
            Directory.CreateDirectory(outputRoot);

            Glb glb = Glb.Read(glbPath);
            GameObject root = BuildScene(glb.Document, glb.Binary, out GameObject[] nodes);
            try
            {
                ConfigureLighting();
                Camera camera = CreateCamera(root);
                float[] samples = AnimationSamples(glb.Document, glb.Binary);
                string[] frames = new string[samples.Length];
                for (int index = 0; index < samples.Length; index++)
                {
                    ApplyAnimation(glb.Document, glb.Binary, nodes, samples[index]);
                    frames[index] = Path.Combine(outputRoot, $"kraken-unity-frame-{index:D2}.png");
                    Render(camera, frames[index]);
                }
                string receiptPath = Path.Combine(outputRoot, "kraken-unity-render-receipt.json");
                File.WriteAllText(receiptPath, JsonUtility.ToJson(new CaptureReceipt
                {
                    receipt_kind = "unity_glb_render.v1",
                    glb_path = glbPath,
                    glb_sha256 = Sha256(File.ReadAllBytes(glbPath)),
                    generator = glb.Document.asset.generator,
                    animation_name = glb.Document.animations != null && glb.Document.animations.Length > 0 ? glb.Document.animations[0].name : null,
                    animation_sample_seconds = samples,
                    frames = Array.ConvertAll(frames, Path.GetFileName),
                    evidence_scope = "Unity Editor Camera.Render of the accepted local GLB; not a remote Blender worker receipt or a player-runtime acceptance.",
                }, true));
                Debug.Log($"[KrakenGlbCapture] Unity rendered {frames.Length} animation frames from {glbPath}; receipt={receiptPath}");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(root);
                foreach (Light light in UnityEngine.Object.FindObjectsByType<Light>(FindObjectsSortMode.None)) UnityEngine.Object.DestroyImmediate(light.gameObject);
                foreach (Camera camera in UnityEngine.Object.FindObjectsByType<Camera>(FindObjectsSortMode.None)) UnityEngine.Object.DestroyImmediate(camera.gameObject);
            }
        }

        private static GameObject BuildScene(Document document, byte[] binary, out GameObject[] nodes)
        {
            nodes = new GameObject[document.nodes.Length];
            for (int index = 0; index < nodes.Length; index++)
            {
                Node definition = document.nodes[index];
                nodes[index] = new GameObject(string.IsNullOrEmpty(definition.name) ? $"node-{index}" : definition.name);
                ApplyNodeTransform(nodes[index].transform, definition);
                if (definition.mesh >= 0) AddMesh(nodes[index], document, binary, document.meshes[definition.mesh]);
            }
            for (int index = 0; index < nodes.Length; index++)
            {
                int[] children = document.nodes[index].children;
                if (children == null) continue;
                foreach (int child in children) nodes[child].transform.SetParent(nodes[index].transform, true);
            }
            GameObject root = new("accepted-kraken-glb");
            int scene = document.scene < 0 ? 0 : document.scene;
            foreach (int node in document.scenes[scene].nodes) nodes[node].transform.SetParent(root.transform, true);
            return root;
        }

        private static void AddMesh(GameObject target, Document document, byte[] binary, MeshDefinition definition)
        {
            foreach (Primitive primitive in definition.primitives)
            {
                Vector3[] positions = Vectors(document, binary, primitive.attributes.POSITION);
                Vector3[] normals = primitive.attributes.NORMAL >= 0 ? Vectors(document, binary, primitive.attributes.NORMAL) : null;
                int[] indices = Indices(document, binary, primitive.indices);
                Mesh mesh = new() { name = definition.name };
                mesh.vertices = positions;
                if (normals != null) mesh.normals = normals;
                mesh.triangles = indices;
                if (normals == null) mesh.RecalculateNormals();
                mesh.RecalculateBounds();
                MeshFilter filter = target.AddComponent<MeshFilter>();
                filter.sharedMesh = mesh;
                MeshRenderer renderer = target.AddComponent<MeshRenderer>();
                renderer.sharedMaterial = Material(document, primitive.material);
            }
        }

        private static Material Material(Document document, int materialIndex)
        {
            Shader shader = Shader.Find("Standard") ?? Shader.Find("Unlit/Color");
            Material material = new(shader);
            float[] factor = materialIndex >= 0 && document.materials != null && materialIndex < document.materials.Length
                ? document.materials[materialIndex].pbrMetallicRoughness.baseColorFactor : null;
            Color color = factor != null && factor.Length == 4 ? new Color(factor[0], factor[1], factor[2], factor[3]) : Color.gray;
            material.color = color;
            material.SetInt("_Cull", 0);
            return material;
        }

        private static void ApplyNodeTransform(Transform target, Node node)
        {
            target.localPosition = node.translation == null ? Vector3.zero : new Vector3(node.translation[0], node.translation[1], node.translation[2]);
            target.localRotation = node.rotation == null ? Quaternion.identity : new Quaternion(node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]);
            target.localScale = node.scale == null ? Vector3.one : new Vector3(node.scale[0], node.scale[1], node.scale[2]);
        }

        private static float[] AnimationSamples(Document document, byte[] binary)
        {
            if (document.animations == null || document.animations.Length == 0) return new[] { 0f };
            float[] times = Floats(document, binary, document.animations[0].samplers[0].input);
            if (times.Length == 0) return new[] { 0f };
            float first = times[0], last = times[times.Length - 1];
            float[] samples = new float[8];
            for (int index = 0; index < samples.Length; index++) samples[index] = Mathf.Lerp(first, last, index / (samples.Length - 1f));
            return samples;
        }

        private static void ApplyAnimation(Document document, byte[] binary, GameObject[] nodes, float time)
        {
            if (document.animations == null || document.animations.Length == 0) return;
            Animation animation = document.animations[0];
            foreach (AnimationChannel channel in animation.channels)
            {
                AnimationSampler sampler = animation.samplers[channel.sampler];
                float[] times = Floats(document, binary, sampler.input);
                Vector4[] values = Vector4s(document, binary, sampler.output);
                if (times.Length == 0 || values.Length == 0 || channel.target.path != "rotation") continue;
                int upper = Array.FindIndex(times, value => value >= time);
                if (upper < 0) upper = times.Length - 1;
                int lower = Math.Max(0, upper - 1);
                float interpolation = lower == upper ? 0f : Mathf.InverseLerp(times[lower], times[upper], time);
                Vector4 value = Vector4.Lerp(values[lower], values[upper], interpolation);
                nodes[channel.target.node].transform.localRotation = new Quaternion(value.x, value.y, value.z, value.w);
            }
        }

        private static Camera CreateCamera(GameObject root)
        {
            Bounds bounds = new(Vector3.zero, Vector3.one);
            bool initialized = false;
            foreach (Renderer renderer in root.GetComponentsInChildren<Renderer>())
            {
                if (!initialized) { bounds = renderer.bounds; initialized = true; }
                else bounds.Encapsulate(renderer.bounds);
            }
            GameObject cameraObject = new("Kraken Capture Camera");
            Camera camera = cameraObject.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.025f, 0.05f, 0.09f, 1f);
            camera.transform.position = bounds.center + new Vector3(3.2f, 2.1f, -4.5f) * Mathf.Max(1f, bounds.extents.magnitude);
            camera.transform.LookAt(bounds.center);
            camera.nearClipPlane = 0.01f;
            camera.farClipPlane = 100f;
            return camera;
        }

        private static void ConfigureLighting()
        {
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.28f, 0.35f, 0.48f);
            Light key = new GameObject("Kraken Key Light").AddComponent<Light>();
            key.type = LightType.Directional;
            key.transform.rotation = Quaternion.Euler(42f, -32f, 0f);
            key.intensity = 1.35f;
            Light rim = new GameObject("Kraken Rim Light").AddComponent<Light>();
            rim.type = LightType.Directional;
            rim.color = new Color(0.25f, 0.68f, 1f);
            rim.transform.rotation = Quaternion.Euler(310f, 135f, 0f);
            rim.intensity = 0.8f;
        }

        private static void Render(Camera camera, string path)
        {
            RenderTexture texture = new(768, 768, 24, RenderTextureFormat.ARGB32);
            camera.targetTexture = texture;
            camera.Render();
            RenderTexture previous = RenderTexture.active;
            RenderTexture.active = texture;
            Texture2D image = new(768, 768, TextureFormat.RGBA32, false);
            image.ReadPixels(new Rect(0, 0, 768, 768), 0, 0);
            image.Apply();
            File.WriteAllBytes(path, image.EncodeToPNG());
            RenderTexture.active = previous;
            camera.targetTexture = null;
            UnityEngine.Object.DestroyImmediate(image);
            UnityEngine.Object.DestroyImmediate(texture);
        }

        private static float[] Floats(Document document, byte[] binary, int accessor) => Read(document, binary, accessor, 1, BitConverter.ToSingle);
        private static Vector3[] Vectors(Document document, byte[] binary, int accessor)
        {
            float[] values = Read(document, binary, accessor, 3, BitConverter.ToSingle);
            Vector3[] vectors = new Vector3[values.Length / 3];
            for (int index = 0; index < vectors.Length; index++) vectors[index] = new Vector3(values[index * 3], values[index * 3 + 1], values[index * 3 + 2]);
            return vectors;
        }
        private static Vector4[] Vector4s(Document document, byte[] binary, int accessor)
        {
            float[] values = Read(document, binary, accessor, 4, BitConverter.ToSingle);
            Vector4[] vectors = new Vector4[values.Length / 4];
            for (int index = 0; index < vectors.Length; index++) vectors[index] = new Vector4(values[index * 4], values[index * 4 + 1], values[index * 4 + 2], values[index * 4 + 3]);
            return vectors;
        }
        private static int[] Indices(Document document, byte[] binary, int accessor)
        {
            Accessor definition = document.accessors[accessor];
            BufferView view = document.bufferViews[definition.bufferView];
            int stride = view.byteStride > 0 ? view.byteStride : definition.componentType == 5125 ? 4 : 2;
            int offset = view.byteOffset + definition.byteOffset;
            int[] values = new int[definition.count];
            for (int index = 0; index < values.Length; index++) values[index] = definition.componentType == 5125 ? BitConverter.ToInt32(binary, offset + index * stride) : BitConverter.ToUInt16(binary, offset + index * stride);
            return values;
        }
        private delegate float FloatReader(byte[] bytes, int offset);
        private static float[] Read(Document document, byte[] binary, int accessor, int components, FloatReader reader)
        {
            Accessor definition = document.accessors[accessor];
            BufferView view = document.bufferViews[definition.bufferView];
            int stride = view.byteStride > 0 ? view.byteStride : components * 4;
            int offset = view.byteOffset + definition.byteOffset;
            float[] values = new float[definition.count * components];
            for (int index = 0; index < definition.count; index++) for (int component = 0; component < components; component++) values[index * components + component] = reader(binary, offset + index * stride + component * 4);
            return values;
        }
        private static string Sha256(byte[] bytes) { using SHA256 hash = SHA256.Create(); return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", string.Empty).ToLowerInvariant(); }

        [Serializable] private sealed class CaptureReceipt { public string receipt_kind; public string glb_path; public string glb_sha256; public string generator; public string animation_name; public float[] animation_sample_seconds; public string[] frames; public string evidence_scope; }
        [Serializable] private sealed class Glb { public Document Document; public byte[] Binary; public static Glb Read(string path) { byte[] bytes = File.ReadAllBytes(path); if (BitConverter.ToInt32(bytes, 0) != GlbMagic || BitConverter.ToInt32(bytes, 4) != 2) throw new InvalidDataException("Expected glTF 2.0 binary"); int offset = 12; int jsonLength = BitConverter.ToInt32(bytes, offset); int jsonType = BitConverter.ToInt32(bytes, offset + 4); offset += 8; if (jsonType != JsonChunk) throw new InvalidDataException("GLB JSON chunk missing"); Document document = JsonUtility.FromJson<Document>(System.Text.Encoding.UTF8.GetString(bytes, offset, jsonLength)); offset += jsonLength; int binaryLength = BitConverter.ToInt32(bytes, offset); int binaryType = BitConverter.ToInt32(bytes, offset + 4); offset += 8; if (binaryType != BinaryChunk) throw new InvalidDataException("GLB binary chunk missing"); byte[] binary = new byte[binaryLength]; Buffer.BlockCopy(bytes, offset, binary, 0, binaryLength); return new Glb { Document = document, Binary = binary }; } }
        [Serializable] private sealed class Document { public Asset asset; public int scene = -1; public Scene[] scenes; public Node[] nodes; public MeshDefinition[] meshes; public Accessor[] accessors; public BufferView[] bufferViews; public MaterialDefinition[] materials; public Animation[] animations; }
        [Serializable] private sealed class Asset { public string generator; }
        [Serializable] private sealed class Scene { public int[] nodes; }
        [Serializable] private sealed class Node { public string name; public int mesh = -1; public int[] children; public float[] translation; public float[] rotation; public float[] scale; }
        [Serializable] private sealed class MeshDefinition { public string name; public Primitive[] primitives; }
        [Serializable] private sealed class Primitive { public Attributes attributes; public int indices; public int material = -1; }
        [Serializable] private sealed class Attributes { public int POSITION = -1; public int NORMAL = -1; }
        [Serializable] private sealed class Accessor { public int bufferView; public int byteOffset; public int componentType; public int count; }
        [Serializable] private sealed class BufferView { public int byteOffset; public int byteStride; }
        [Serializable] private sealed class MaterialDefinition { public Pbr pbrMetallicRoughness; }
        [Serializable] private sealed class Pbr { public float[] baseColorFactor; }
        [Serializable] private sealed class Animation { public string name; public AnimationChannel[] channels; public AnimationSampler[] samplers; }
        [Serializable] private sealed class AnimationChannel { public int sampler; public AnimationTarget target; }
        [Serializable] private sealed class AnimationTarget { public int node; public string path; }
        [Serializable] private sealed class AnimationSampler { public int input; public int output; }
    }
}
