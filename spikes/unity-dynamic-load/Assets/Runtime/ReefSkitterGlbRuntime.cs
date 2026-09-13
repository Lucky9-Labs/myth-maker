using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEngine.Rendering;

namespace MythMaker.DynamicAssemblySpike
{
    /// <summary>Runtime loader for an already-parted GLB; it never segments meshes.</summary>
    public sealed class ReefSkitterGlbRuntime : IDisposable
    {
        private const int GlbMagic = 0x46546C67;
        private const int JsonChunk = 0x4E4F534A;
        private const int BinaryChunk = 0x004E4942;

        public readonly struct Part
        {
            public readonly string Name;
            public readonly int NodeIndex;
            public readonly Mesh Mesh;
            public readonly Material Material;
            public readonly Matrix4x4 LocalMatrix;
            public Part(string name, int nodeIndex, Mesh mesh, Material material, Matrix4x4 localMatrix) { Name = name; NodeIndex = nodeIndex; Mesh = mesh; Material = material; LocalMatrix = localMatrix; }
        }

        public IReadOnlyList<Part> Parts => parts;
        public Bounds Bounds { get; }
        public string Generator { get; }
        public int SourceAnimationCount { get; }
        public bool HasCompleteAnimationSet => animationSamples != null;
        public int AnimationSamplesPerClip => animationSamples == null ? 0 : SamplesPerClip;
        public int AnimationJointCount => animationJointCount;
        public IReadOnlyList<string> AnimationClipNames => clipNames;
        public float[] AnimationClipDurations => clipDurations;
        public Matrix4x4[] BoneAnimationSamples => animationSamples;
        private readonly List<Part> parts;
        private readonly string[] clipNames;
        private readonly float[] clipDurations;
        private readonly Matrix4x4[] animationSamples;
        private readonly int animationJointCount;
        private const int SamplesPerClip = 32;
        private static readonly string[] RequiredClips = { "idle", "walk", "run", "attack", "death" };

        private ReefSkitterGlbRuntime(List<Part> parts, Bounds bounds, string generator, int sourceAnimationCount, string[] clipNames, float[] clipDurations, Matrix4x4[] animationSamples, int animationJointCount)
        { this.parts = parts; Bounds = bounds; Generator = generator; SourceAnimationCount = sourceAnimationCount; this.clipNames = clipNames; this.clipDurations = clipDurations; this.animationSamples = animationSamples; this.animationJointCount = animationJointCount; }

        public static ReefSkitterGlbRuntime Load(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new FileNotFoundException("Reef Skitter GLB was not found", path);
            ReadGlb(path, out Document document, out byte[] binary);
            if (document.nodes == null || document.meshes == null || document.nodes.Length < 2) throw new InvalidDataException("Parted GLB requires nodes and meshes");
            int[] parents = BuildParentIndexes(document.nodes); Matrix4x4[] worldMatrices = new Matrix4x4[document.nodes.Length]; byte[] visitState = new byte[document.nodes.Length];
            List<Part> loaded = new List<Part>(); Bounds aggregate = default; bool hasBounds = false;
            for (int nodeIndex = 0; nodeIndex < document.nodes.Length; nodeIndex++)
            {
                Node node = document.nodes[nodeIndex]; if (node.mesh < 0) continue;
                if (node.mesh >= document.meshes.Length) throw new InvalidDataException("Node mesh index is outside the GLB");
                MeshDefinition definition = document.meshes[node.mesh];
                if (definition.primitives == null || definition.primitives.Length != 1) throw new InvalidDataException("Runtime requires one primitive per provider part");
                Primitive primitive = definition.primitives[0]; Mesh mesh = BuildMesh(document, binary, definition, primitive);
                Material material = BuildMaterial(primitive.material, loaded.Count);
                Matrix4x4 partMatrix = ConvertHandedness(WorldMatrix(nodeIndex, document.nodes, parents, worldMatrices, visitState));
                loaded.Add(new Part(string.IsNullOrEmpty(node.name) ? $"part-{nodeIndex}" : node.name, nodeIndex, mesh, material, partMatrix));
                Bounds transformed = TransformBounds(mesh.bounds, partMatrix);
                if (!hasBounds) { aggregate = transformed; hasBounds = true; } else aggregate.Encapsulate(transformed);
            }
            if (loaded.Count < 2) throw new InvalidDataException("GLB is monolithic; already-parted source required");
            BuildAnimationLibrary(document, binary, loaded, parents, out string[] clipNames, out float[] clipDurations, out Matrix4x4[] animationSamples, out int animationJointCount);
            return new ReefSkitterGlbRuntime(loaded, aggregate, document.asset == null ? "unknown" : document.asset.generator, document.animations == null ? 0 : document.animations.Length, clipNames, clipDurations, animationSamples, animationJointCount);
        }

        private static void BuildAnimationLibrary(Document document, byte[] binary, List<Part> parts, int[] parents, out string[] clipNames, out float[] clipDurations, out Matrix4x4[] samples, out int jointCount)
        {
            clipNames = Array.Empty<string>(); clipDurations = Array.Empty<float>(); samples = null; jointCount = 0;
            if (document.animations == null || document.animations.Length == 0) return;
            if (document.animations.Length != RequiredClips.Length) throw new InvalidDataException("Animated Reef Skitter requires exactly idle, walk, run, attack, and death");
            if (document.skins == null || document.skins.Length != 1) throw new InvalidDataException("Animated Reef Skitter requires one shared skin");
            if (document.scenes == null || document.scene < 0 || document.scene >= document.scenes.Length || document.scenes[document.scene].nodes == null || document.scenes[document.scene].nodes.Length != 1)
                throw new InvalidDataException("Animated Reef Skitter requires one scene root");
            Skin skin = document.skins[0]; ValidateSkin(document.nodes, skin, parents); jointCount = skin.joints.Length;
            foreach (Part part in parts)
                if (document.nodes[part.NodeIndex].skin != 0) throw new InvalidDataException("Every retained provider part must reference the shared skin");
            Matrix4x4[] inverseBind = ReadMatrices(document, binary, skin.inverseBindMatrices);
            if (inverseBind.Length != jointCount) throw new InvalidDataException("Inverse bind matrix count must match the shared joint set");

            Dictionary<string, Animation> byName = new Dictionary<string, Animation>(StringComparer.Ordinal);
            foreach (Animation animation in document.animations)
                if (animation == null || string.IsNullOrEmpty(animation.name) || !byName.TryAdd(animation.name, animation)) throw new InvalidDataException("Animation names must be unique");
            clipNames = (string[])RequiredClips.Clone(); clipDurations = new float[RequiredClips.Length];
            samples = new Matrix4x4[RequiredClips.Length * SamplesPerClip * jointCount];

            HashSet<int> jointNodes = new HashSet<int>(skin.joints);
            for (int clipIndex = 0; clipIndex < RequiredClips.Length; clipIndex++)
            {
                if (!byName.TryGetValue(RequiredClips[clipIndex], out Animation animation)) throw new InvalidDataException($"Missing required animation {RequiredClips[clipIndex]}");
                if (animation.channels == null || animation.samplers == null || animation.channels.Length == 0) throw new InvalidDataException($"Animation {animation.name} must animate the shared skin");
                HashSet<string> channelKeys = new HashSet<string>(StringComparer.Ordinal); float duration = 0f;
                foreach (AnimationChannel channel in animation.channels)
                {
                    string key = channel == null || channel.target == null ? null : $"{channel.target.node}:{channel.target.path}";
                    if (channel == null || channel.target == null || !jointNodes.Contains(channel.target.node) || !channelKeys.Add(key)
                        || channel.sampler < 0 || channel.sampler >= animation.samplers.Length || !IsTransformPath(channel.target.path))
                        throw new InvalidDataException($"Animation {animation.name} has an invalid, non-joint, or duplicate channel");
                    float[] times = ReadFloatScalars(document, binary, animation.samplers[channel.sampler].input);
                    if (times.Length < 2 || times[0] < 0f || times[times.Length - 1] <= times[0]) throw new InvalidDataException($"Animation {animation.name} has invalid key times");
                    duration = Mathf.Max(duration, times[times.Length - 1]);
                }
                if (duration <= 0f) throw new InvalidDataException($"Animation {animation.name} has no positive duration");
                clipDurations[clipIndex] = duration;
                for (int sampleIndex = 0; sampleIndex < SamplesPerClip; sampleIndex++)
                {
                    float normalized = sampleIndex / (float)(SamplesPerClip - 1); float time = normalized * duration;
                    Matrix4x4[] local = BaseLocalMatrices(document.nodes);
                    foreach (AnimationChannel channel in animation.channels) ApplyChannel(document, binary, animation.samplers[channel.sampler], channel.target, time, local);
                    Matrix4x4[] world = new Matrix4x4[document.nodes.Length]; byte[] state = new byte[document.nodes.Length];
                    for (int jointIndex = 0; jointIndex < jointCount; jointIndex++)
                        samples[(clipIndex * SamplesPerClip + sampleIndex) * jointCount + jointIndex] = ConvertHandedness(WorldMatrix(skin.joints[jointIndex], local, parents, world, state) * inverseBind[jointIndex]);
                }
            }
        }

        private static void ValidateSkin(Node[] nodes, Skin skin, int[] parents)
        {
            if (skin == null || skin.joints == null || skin.joints.Length < 2 || skin.inverseBindMatrices < 0) throw new InvalidDataException("Shared skin requires joints and inverse bind matrices");
            HashSet<int> unique = new HashSet<int>();
            foreach (int joint in skin.joints)
                if (joint < 0 || joint >= nodes.Length || !unique.Add(joint) || nodes[joint].mesh >= 0) throw new InvalidDataException("Skin joint set is invalid");
            if (skin.skeleton >= 0)
            {
                if (skin.skeleton >= nodes.Length) throw new InvalidDataException("Skin skeleton root is invalid");
                foreach (int joint in skin.joints)
                {
                    int cursor = joint;
                    while (cursor >= 0 && cursor != skin.skeleton) cursor = parents[cursor];
                    if (cursor != skin.skeleton) throw new InvalidDataException("Every joint must descend from the shared skeleton root");
                }
            }
        }

        private static bool IsTransformPath(string path) => path == "translation" || path == "rotation" || path == "scale";

        private static Matrix4x4[] BaseLocalMatrices(Node[] nodes)
        {
            Matrix4x4[] result = new Matrix4x4[nodes.Length];
            for (int index = 0; index < nodes.Length; index++) result[index] = NodeMatrix(nodes[index]);
            return result;
        }

        private static void ApplyChannel(Document document, byte[] binary, AnimationSampler sampler, AnimationTarget target, float time, Matrix4x4[] local)
        {
            if (sampler == null || sampler.input < 0 || sampler.output < 0 || (sampler.interpolation != null && sampler.interpolation != "LINEAR" && sampler.interpolation != "STEP"))
                throw new InvalidDataException("Only LINEAR and STEP animation samplers are supported");
            Node node = document.nodes[target.node];
            if (node.matrix != null) throw new InvalidDataException("Animated joints must use decomposable TRS transforms");
            float[] times = ReadFloatScalars(document, binary, sampler.input);
            int upper = Array.BinarySearch(times, time); if (upper < 0) upper = ~upper;
            if (upper <= 0) upper = 0; else if (upper >= times.Length) upper = times.Length - 1;
            int lower = Mathf.Max(0, upper - 1); float blend = upper == lower || sampler.interpolation == "STEP" ? 0f : Mathf.InverseLerp(times[lower], times[upper], time);
            Matrix4x4 current = local[target.node]; Vector3 translation = current.GetColumn(3), scale = current.lossyScale; Quaternion rotation = current.rotation;
            if (target.path == "rotation")
            {
                Quaternion[] values = ReadQuaternions(document, binary, sampler.output);
                if (values.Length != times.Length) throw new InvalidDataException("Rotation animation input/output counts differ");
                rotation = Quaternion.Slerp(values[lower], values[upper], blend);
            }
            else
            {
                Vector3[] values = ReadVector3(document, binary, sampler.output, false);
                if (values.Length != times.Length) throw new InvalidDataException("Vector animation input/output counts differ");
                Vector3 value = Vector3.Lerp(values[lower], values[upper], blend);
                if (target.path == "translation") translation = value; else scale = value;
            }
            local[target.node] = Matrix4x4.TRS(translation, rotation, scale);
        }

        public void Dispose()
        {
            foreach (Part part in parts)
            {
                if (part.Mesh != null) { if (Application.isPlaying) UnityEngine.Object.Destroy(part.Mesh); else UnityEngine.Object.DestroyImmediate(part.Mesh); }
                if (part.Material != null) { if (Application.isPlaying) UnityEngine.Object.Destroy(part.Material); else UnityEngine.Object.DestroyImmediate(part.Material); }
            }
            parts.Clear();
        }

        private static Mesh BuildMesh(Document document, byte[] binary, MeshDefinition definition, Primitive primitive)
        {
            if (primitive.attributes == null || primitive.attributes.POSITION < 0 || primitive.indices < 0) throw new InvalidDataException("Part primitive lacks positions or indices");
            Vector3[] vertices = ReadVector3(document, binary, primitive.attributes.POSITION);
            Vector3[] normals = primitive.attributes.NORMAL >= 0 ? ReadVector3(document, binary, primitive.attributes.NORMAL) : null;
            int[] indices = ReadIndices(document, binary, primitive.indices);
            Mesh mesh = new Mesh { name = string.IsNullOrEmpty(definition.name) ? "reef-skitter-part" : definition.name };
            if (vertices.Length > ushort.MaxValue) mesh.indexFormat = IndexFormat.UInt32;
            mesh.vertices = vertices; mesh.triangles = indices;
            bool hasJoints = primitive.attributes.JOINTS_0 >= 0, hasWeights = primitive.attributes.WEIGHTS_0 >= 0;
            if (hasJoints != hasWeights) throw new InvalidDataException("Skinned primitive must provide both JOINTS_0 and WEIGHTS_0");
            if (primitive.attributes.JOINTS_1 >= 0 || primitive.attributes.WEIGHTS_1 >= 0) throw new InvalidDataException("Runtime supports at most four shared-skin influences per vertex");
            if (hasJoints)
            {
                if (document.skins == null || document.skins.Length != 1) throw new InvalidDataException("Skinned primitives require one shared skin");
                int[,] joints = ReadJointIndexes(document, binary, primitive.attributes.JOINTS_0);
                float[,] weights = ReadWeights(document, binary, primitive.attributes.WEIGHTS_0);
                if (joints.GetLength(0) != vertices.Length || weights.GetLength(0) != vertices.Length) throw new InvalidDataException("Skin attributes must match the vertex count");
                BoneWeight[] boneWeights = new BoneWeight[vertices.Length];
                for (int vertex = 0; vertex < vertices.Length; vertex++)
                {
                    float sum = weights[vertex, 0] + weights[vertex, 1] + weights[vertex, 2] + weights[vertex, 3];
                    if (sum <= .00001f) throw new InvalidDataException("Every skinned vertex requires a positive joint weight");
                    for (int lane = 0; lane < 4; lane++) if (joints[vertex, lane] >= document.skins[0].joints.Length) throw new InvalidDataException("Vertex joint index is outside the shared skin");
                    boneWeights[vertex] = new BoneWeight
                    {
                        boneIndex0 = joints[vertex, 0], boneIndex1 = joints[vertex, 1], boneIndex2 = joints[vertex, 2], boneIndex3 = joints[vertex, 3],
                        weight0 = weights[vertex, 0] / sum, weight1 = weights[vertex, 1] / sum, weight2 = weights[vertex, 2] / sum, weight3 = weights[vertex, 3] / sum
                    };
                }
                mesh.boneWeights = boneWeights;
            }
            if (normals != null && normals.Length == vertices.Length) mesh.normals = normals; else mesh.RecalculateNormals();
            mesh.RecalculateBounds(); mesh.UploadMeshData(true); return mesh;
        }

        private static Material BuildMaterial(int materialIndex, int partIndex)
        {
            Shader shader = Resources.Load<Shader>("ReefSkitterInstanced");
            if (shader == null) throw new InvalidOperationException("Embedded Reef Skitter instancing shader is unavailable");
            float variation = (partIndex % 5) * .035f;
            Material material = new Material(shader) { name = $"reef-skitter-material-{materialIndex}", enableInstancing = true, color = new Color(.055f + variation, .19f + variation, .21f + variation, 1f) };
            return material;
        }

        private static void ReadGlb(string path, out Document document, out byte[] binary)
        {
            byte[] bytes = File.ReadAllBytes(path);
            if (bytes.Length < 20 || BitConverter.ToInt32(bytes, 0) != GlbMagic || BitConverter.ToInt32(bytes, 4) != 2 || BitConverter.ToInt32(bytes, 8) != bytes.Length) throw new InvalidDataException("Expected a complete glTF 2.0 binary");
            int offset = 12; int jsonLength = BitConverter.ToInt32(bytes, offset); int jsonType = BitConverter.ToInt32(bytes, offset + 4); offset += 8;
            if (jsonType != JsonChunk || offset + jsonLength > bytes.Length) throw new InvalidDataException("GLB JSON chunk is invalid");
            document = JsonUtility.FromJson<Document>(System.Text.Encoding.UTF8.GetString(bytes, offset, jsonLength)); offset += jsonLength;
            if (offset + 8 > bytes.Length) throw new InvalidDataException("GLB binary chunk is missing");
            int binaryLength = BitConverter.ToInt32(bytes, offset); int binaryType = BitConverter.ToInt32(bytes, offset + 4); offset += 8;
            if (binaryType != BinaryChunk || offset + binaryLength > bytes.Length) throw new InvalidDataException("GLB binary chunk is invalid");
            binary = new byte[binaryLength]; Buffer.BlockCopy(bytes, offset, binary, 0, binaryLength);
        }

        private static Vector3[] ReadVector3(Document document, byte[] binary, int accessorIndex, bool mirrorX = true)
        {
            RequireAccessorIndex(document, accessorIndex);
            Accessor accessor = document.accessors[accessorIndex]; BufferView view = document.bufferViews[accessor.bufferView];
            if (accessor.componentType != 5126 || accessor.count < 1 || accessor.type != "VEC3") throw new InvalidDataException("Expected float VEC3 accessor");
            int stride = view.byteStride > 0 ? view.byteStride : 12; int offset = view.byteOffset + accessor.byteOffset; Vector3[] result = new Vector3[accessor.count];
            RequireBinaryRange(binary, offset, stride, accessor.count, 12);
            for (int index = 0; index < result.Length; index++)
            {
                float x = BitConverter.ToSingle(binary, offset + index * stride);
                result[index] = new Vector3(mirrorX ? -x : x, BitConverter.ToSingle(binary, offset + index * stride + 4), BitConverter.ToSingle(binary, offset + index * stride + 8));
                if (!IsFinite(result[index].x) || !IsFinite(result[index].y) || !IsFinite(result[index].z)) throw new InvalidDataException("Vector accessor contains a non-finite value");
            }
            return result;
        }

        private static Quaternion[] ReadQuaternions(Document document, byte[] binary, int accessorIndex)
        {
            RequireAccessorIndex(document, accessorIndex);
            Accessor accessor = document.accessors[accessorIndex]; BufferView view = document.bufferViews[accessor.bufferView];
            if (accessor.componentType != 5126 || accessor.count < 1 || accessor.type != "VEC4") throw new InvalidDataException("Expected float VEC4 accessor");
            int stride = view.byteStride > 0 ? view.byteStride : 16; int offset = view.byteOffset + accessor.byteOffset; Quaternion[] result = new Quaternion[accessor.count];
            RequireBinaryRange(binary, offset, stride, accessor.count, 16);
            for (int index = 0; index < result.Length; index++)
            {
                int item = offset + index * stride;
                Quaternion value = new Quaternion(BitConverter.ToSingle(binary, item), BitConverter.ToSingle(binary, item + 4), BitConverter.ToSingle(binary, item + 8), BitConverter.ToSingle(binary, item + 12));
                if (!IsFinite(value.x) || !IsFinite(value.y) || !IsFinite(value.z) || !IsFinite(value.w) || Quaternion.Dot(value, value) <= .000001f) throw new InvalidDataException("Rotation accessor contains an invalid quaternion");
                result[index] = value.normalized;
            }
            return result;
        }

        private static float[] ReadFloatScalars(Document document, byte[] binary, int accessorIndex)
        {
            RequireAccessorIndex(document, accessorIndex);
            Accessor accessor = document.accessors[accessorIndex]; BufferView view = document.bufferViews[accessor.bufferView];
            if (accessor.componentType != 5126 || accessor.count < 1 || accessor.type != "SCALAR") throw new InvalidDataException("Expected float SCALAR accessor");
            int stride = view.byteStride > 0 ? view.byteStride : 4; int offset = view.byteOffset + accessor.byteOffset; float[] result = new float[accessor.count];
            RequireBinaryRange(binary, offset, stride, accessor.count, 4);
            for (int index = 0; index < result.Length; index++) { result[index] = BitConverter.ToSingle(binary, offset + index * stride); if (!IsFinite(result[index])) throw new InvalidDataException("Scalar accessor contains a non-finite value"); }
            for (int index = 1; index < result.Length; index++) if (result[index] < result[index - 1]) throw new InvalidDataException("Animation key times must be ascending");
            return result;
        }

        private static Matrix4x4[] ReadMatrices(Document document, byte[] binary, int accessorIndex)
        {
            RequireAccessorIndex(document, accessorIndex);
            Accessor accessor = document.accessors[accessorIndex]; BufferView view = document.bufferViews[accessor.bufferView];
            if (accessor.componentType != 5126 || accessor.count < 1 || accessor.type != "MAT4") throw new InvalidDataException("Expected float MAT4 accessor");
            int stride = view.byteStride > 0 ? view.byteStride : 64; int offset = view.byteOffset + accessor.byteOffset; Matrix4x4[] result = new Matrix4x4[accessor.count];
            RequireBinaryRange(binary, offset, stride, accessor.count, 64);
            for (int index = 0; index < result.Length; index++)
            {
                Matrix4x4 matrix = new Matrix4x4(); int item = offset + index * stride;
                for (int column = 0; column < 4; column++) for (int row = 0; row < 4; row++) { matrix[row, column] = BitConverter.ToSingle(binary, item + (column * 4 + row) * 4); if (!IsFinite(matrix[row, column])) throw new InvalidDataException("Matrix accessor contains a non-finite value"); }
                result[index] = matrix;
            }
            return result;
        }

        private static int[,] ReadJointIndexes(Document document, byte[] binary, int accessorIndex)
        {
            RequireAccessorIndex(document, accessorIndex);
            Accessor accessor = document.accessors[accessorIndex]; BufferView view = document.bufferViews[accessor.bufferView];
            int width = accessor.componentType == 5121 ? 1 : accessor.componentType == 5123 ? 2 : 0;
            if (width == 0 || accessor.count < 1 || accessor.type != "VEC4") throw new InvalidDataException("Expected unsigned VEC4 joint accessor");
            int elementBytes = width * 4, stride = view.byteStride > 0 ? view.byteStride : elementBytes, offset = view.byteOffset + accessor.byteOffset; int[,] result = new int[accessor.count, 4];
            RequireBinaryRange(binary, offset, stride, accessor.count, elementBytes);
            for (int index = 0; index < accessor.count; index++) for (int lane = 0; lane < 4; lane++)
                result[index, lane] = width == 1 ? binary[offset + index * stride + lane] : BitConverter.ToUInt16(binary, offset + index * stride + lane * 2);
            return result;
        }

        private static float[,] ReadWeights(Document document, byte[] binary, int accessorIndex)
        {
            RequireAccessorIndex(document, accessorIndex);
            Accessor accessor = document.accessors[accessorIndex]; BufferView view = document.bufferViews[accessor.bufferView];
            int width = accessor.componentType == 5126 ? 4 : accessor.componentType == 5123 ? 2 : accessor.componentType == 5121 ? 1 : 0;
            if (width == 0 || accessor.count < 1 || accessor.type != "VEC4" || (accessor.componentType != 5126 && !accessor.normalized)) throw new InvalidDataException("Expected float or normalized unsigned VEC4 weight accessor");
            int elementBytes = width * 4, stride = view.byteStride > 0 ? view.byteStride : elementBytes, offset = view.byteOffset + accessor.byteOffset; float[,] result = new float[accessor.count, 4];
            RequireBinaryRange(binary, offset, stride, accessor.count, elementBytes);
            for (int index = 0; index < accessor.count; index++) for (int lane = 0; lane < 4; lane++)
            {
                int item = offset + index * stride + lane * width;
                result[index, lane] = accessor.componentType == 5126 ? BitConverter.ToSingle(binary, item) : accessor.componentType == 5123 ? BitConverter.ToUInt16(binary, item) / 65535f : binary[item] / 255f;
                if (!IsFinite(result[index, lane]) || result[index, lane] < 0f) throw new InvalidDataException("Weight accessor contains an invalid value");
            }
            return result;
        }

        private static void RequireAccessorIndex(Document document, int accessorIndex)
        {
            if (document.accessors == null || document.bufferViews == null || accessorIndex < 0 || accessorIndex >= document.accessors.Length
                || document.accessors[accessorIndex].bufferView < 0 || document.accessors[accessorIndex].bufferView >= document.bufferViews.Length)
                throw new InvalidDataException("Accessor references an invalid buffer view");
        }

        private static void RequireBinaryRange(byte[] binary, int offset, int stride, int count, int elementBytes)
        {
            long end = (long)offset + (long)(count - 1) * stride + elementBytes;
            if (offset < 0 || stride < elementBytes || end > binary.Length) throw new InvalidDataException("Accessor data is outside the GLB binary chunk");
        }

        private static int[] ReadIndices(Document document, byte[] binary, int accessorIndex)
        {
            Accessor accessor = document.accessors[accessorIndex]; BufferView view = document.bufferViews[accessor.bufferView];
            int width = accessor.componentType == 5125 ? 4 : accessor.componentType == 5123 ? 2 : 0;
            if (width == 0 || accessor.count < 3 || accessor.count % 3 != 0) throw new InvalidDataException("Expected unsigned triangle indices");
            int stride = view.byteStride > 0 ? view.byteStride : width; int offset = view.byteOffset + accessor.byteOffset; int[] result = new int[accessor.count];
            for (int index = 0; index < result.Length; index++) result[index] = width == 4 ? checked((int)BitConverter.ToUInt32(binary, offset + index * stride)) : BitConverter.ToUInt16(binary, offset + index * stride);
            for (int index = 0; index < result.Length; index += 3) (result[index + 1], result[index + 2]) = (result[index + 2], result[index + 1]);
            return result;
        }

        private static int[] BuildParentIndexes(Node[] nodes)
        {
            int[] parents = new int[nodes.Length]; Array.Fill(parents, -1);
            for (int parent = 0; parent < nodes.Length; parent++)
            {
                if (nodes[parent].children == null) continue;
                foreach (int child in nodes[parent].children)
                {
                    if (child < 0 || child >= nodes.Length || parents[child] >= 0) throw new InvalidDataException("GLB node hierarchy has an invalid or duplicate parent");
                    parents[child] = parent;
                }
            }
            return parents;
        }

        private static Matrix4x4 WorldMatrix(int index, Node[] nodes, int[] parents, Matrix4x4[] cache, byte[] visitState)
        {
            if (visitState[index] == 2) return cache[index];
            if (visitState[index] == 1) throw new InvalidDataException("GLB node hierarchy is cyclic");
            visitState[index] = 1;
            Matrix4x4 local = NodeMatrix(nodes[index]);
            Matrix4x4 world = parents[index] < 0 ? local : WorldMatrix(parents[index], nodes, parents, cache, visitState) * local;
            visitState[index] = 2; return cache[index] = world;
        }

        private static Matrix4x4 WorldMatrix(int index, Matrix4x4[] local, int[] parents, Matrix4x4[] cache, byte[] visitState)
        {
            if (visitState[index] == 2) return cache[index];
            if (visitState[index] == 1) throw new InvalidDataException("GLB node hierarchy is cyclic");
            visitState[index] = 1;
            Matrix4x4 world = parents[index] < 0 ? local[index] : WorldMatrix(parents[index], local, parents, cache, visitState) * local[index];
            visitState[index] = 2; return cache[index] = world;
        }

        private static Matrix4x4 NodeMatrix(Node node)
        {
            if (node.matrix != null)
            {
                if (node.matrix.Length != 16) throw new InvalidDataException("GLB node matrix must contain 16 values");
                Matrix4x4 matrix = new Matrix4x4();
                for (int column = 0; column < 4; column++) for (int row = 0; row < 4; row++) matrix[row, column] = node.matrix[column * 4 + row];
                return matrix;
            }
            return Matrix4x4.TRS(Vector(node.translation), QuaternionValue(node.rotation), Vector(node.scale, Vector3.one));
        }

        private static Matrix4x4 ConvertHandedness(Matrix4x4 matrix)
        {
            Matrix4x4 mirrorX = Matrix4x4.Scale(new Vector3(-1f, 1f, 1f));
            return mirrorX * matrix * mirrorX;
        }

        private static Bounds TransformBounds(Bounds source, Matrix4x4 matrix)
        {
            Vector3 center = matrix.MultiplyPoint3x4(source.center), extents = source.extents;
            Vector3 x = matrix.MultiplyVector(new Vector3(extents.x, 0f, 0f)), y = matrix.MultiplyVector(new Vector3(0f, extents.y, 0f)), z = matrix.MultiplyVector(new Vector3(0f, 0f, extents.z));
            return new Bounds(center, 2f * new Vector3(Mathf.Abs(x.x) + Mathf.Abs(y.x) + Mathf.Abs(z.x), Mathf.Abs(x.y) + Mathf.Abs(y.y) + Mathf.Abs(z.y), Mathf.Abs(x.z) + Mathf.Abs(y.z) + Mathf.Abs(z.z)));
        }
        private static Vector3 Vector(float[] value, Vector3 fallback = default) => value == null || value.Length != 3 ? fallback : new Vector3(value[0], value[1], value[2]);
        private static Quaternion QuaternionValue(float[] value) => value == null || value.Length != 4 ? Quaternion.identity : new Quaternion(value[0], value[1], value[2], value[3]);
        private static bool IsFinite(float value) => !float.IsNaN(value) && !float.IsInfinity(value);

        [Serializable] private sealed class Document { public Asset asset; public int scene; public Scene[] scenes; public Node[] nodes; public MeshDefinition[] meshes; public Accessor[] accessors; public BufferView[] bufferViews; public Animation[] animations; public Skin[] skins; }
        [Serializable] private sealed class Asset { public string generator; }
        [Serializable] private sealed class Node { public string name; public int mesh = -1; public int skin = -1; public int[] children; public float[] matrix; public float[] translation; public float[] rotation; public float[] scale; }
        [Serializable] private sealed class MeshDefinition { public string name; public Primitive[] primitives; }
        [Serializable] private sealed class Primitive { public Attributes attributes; public int indices = -1; public int material = -1; }
        [Serializable] private sealed class Attributes { public int POSITION = -1; public int NORMAL = -1; public int JOINTS_0 = -1; public int WEIGHTS_0 = -1; public int JOINTS_1 = -1; public int WEIGHTS_1 = -1; }
        [Serializable] private sealed class Accessor { public int bufferView = -1; public int byteOffset; public int componentType; public int count; public string type; public bool normalized; }
        [Serializable] private sealed class BufferView { public int byteOffset; public int byteStride; }
        [Serializable] private sealed class Animation { public string name; public AnimationSampler[] samplers; public AnimationChannel[] channels; }
        [Serializable] private sealed class AnimationSampler { public int input = -1; public int output = -1; public string interpolation; }
        [Serializable] private sealed class AnimationChannel { public int sampler = -1; public AnimationTarget target; }
        [Serializable] private sealed class AnimationTarget { public int node = -1; public string path; }
        [Serializable] private sealed class Skin { public int inverseBindMatrices = -1; public int[] joints; public int skeleton = -1; }
        [Serializable] private sealed class Scene { public int[] nodes; }
    }
}
