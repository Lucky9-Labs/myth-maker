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
            public readonly Mesh Mesh;
            public readonly Material Material;
            public readonly Matrix4x4 LocalMatrix;
            public Part(string name, Mesh mesh, Material material, Matrix4x4 localMatrix) { Name = name; Mesh = mesh; Material = material; LocalMatrix = localMatrix; }
        }

        public IReadOnlyList<Part> Parts => parts;
        public Bounds Bounds { get; }
        public string Generator { get; }
        public int SourceAnimationCount { get; }
        private readonly List<Part> parts;

        private ReefSkitterGlbRuntime(List<Part> parts, Bounds bounds, string generator, int sourceAnimationCount)
        { this.parts = parts; Bounds = bounds; Generator = generator; SourceAnimationCount = sourceAnimationCount; }

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
                loaded.Add(new Part(string.IsNullOrEmpty(node.name) ? $"part-{nodeIndex}" : node.name, mesh, material, partMatrix));
                Bounds transformed = TransformBounds(mesh.bounds, partMatrix);
                if (!hasBounds) { aggregate = transformed; hasBounds = true; } else aggregate.Encapsulate(transformed);
            }
            if (loaded.Count < 2) throw new InvalidDataException("GLB is monolithic; already-parted source required");
            return new ReefSkitterGlbRuntime(loaded, aggregate, document.asset == null ? "unknown" : document.asset.generator, document.animations == null ? 0 : document.animations.Length);
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

        private static Vector3[] ReadVector3(Document document, byte[] binary, int accessorIndex)
        {
            Accessor accessor = document.accessors[accessorIndex]; BufferView view = document.bufferViews[accessor.bufferView];
            if (accessor.componentType != 5126 || accessor.count < 1) throw new InvalidDataException("Expected float VEC3 accessor");
            int stride = view.byteStride > 0 ? view.byteStride : 12; int offset = view.byteOffset + accessor.byteOffset; Vector3[] result = new Vector3[accessor.count];
            for (int index = 0; index < result.Length; index++) result[index] = new Vector3(-BitConverter.ToSingle(binary, offset + index * stride), BitConverter.ToSingle(binary, offset + index * stride + 4), BitConverter.ToSingle(binary, offset + index * stride + 8));
            return result;
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

        [Serializable] private sealed class Document { public Asset asset; public Node[] nodes; public MeshDefinition[] meshes; public Accessor[] accessors; public BufferView[] bufferViews; public Animation[] animations; }
        [Serializable] private sealed class Asset { public string generator; }
        [Serializable] private sealed class Node { public string name; public int mesh = -1; public int[] children; public float[] matrix; public float[] translation; public float[] rotation; public float[] scale; }
        [Serializable] private sealed class MeshDefinition { public string name; public Primitive[] primitives; }
        [Serializable] private sealed class Primitive { public Attributes attributes; public int indices = -1; public int material = -1; }
        [Serializable] private sealed class Attributes { public int POSITION = -1; public int NORMAL = -1; }
        [Serializable] private sealed class Accessor { public int bufferView; public int byteOffset; public int componentType; public int count; }
        [Serializable] private sealed class BufferView { public int byteOffset; public int byteStride; }
        [Serializable] private sealed class Animation { public string name; }
    }
}
