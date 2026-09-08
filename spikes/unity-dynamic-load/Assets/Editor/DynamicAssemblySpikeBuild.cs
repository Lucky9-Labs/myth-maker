using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEditor.Build.Reporting;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace MythMaker.DynamicAssemblySpike.Editor
{
    public static class DynamicAssemblySpikeBuild
    {
        private const string ScenePath = "Assets/DynamicAssemblySpike.unity";
        private const string OutputPath = "Build/DynamicAssemblySpike.app";

        [MenuItem("Myth Maker/Create Dynamic Assembly Spike Scene")]
        public static void CreateScene()
        {
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            GameObject root = new("Dynamic Assembly Drop Host");
            DynamicAssemblyDropHost host = root.AddComponent<DynamicAssemblyDropHost>();
            SerializedObject serializedHost = new(host);
            TextAsset fixture = AssetDatabase.LoadAssetAtPath<TextAsset>("Assets/Runtime/Resources/DynamicPluginFixture.bytes");
            serializedHost.FindProperty("pluginAssembly").objectReferenceValue = fixture;
            serializedHost.FindProperty("expectedSha256").stringValue = fixture == null ? string.Empty : ComputeSha256(File.ReadAllBytes(AssetDatabase.GetAssetPath(fixture)));
            serializedHost.ApplyModifiedPropertiesWithoutUndo();
            EditorSceneManager.SaveScene(scene, ScenePath);
        }

        public static void BuildStandaloneMono()
        {
            CreateScene();
            ScriptingImplementation previousBackend = PlayerSettings.GetScriptingBackend(BuildTargetGroup.Standalone);
            ManagedStrippingLevel previousStripping = PlayerSettings.GetManagedStrippingLevel(BuildTargetGroup.Standalone);
            try
            {
                PlayerSettings.SetScriptingBackend(BuildTargetGroup.Standalone, ScriptingImplementation.Mono2x);
                PlayerSettings.SetManagedStrippingLevel(BuildTargetGroup.Standalone, ManagedStrippingLevel.Disabled);
                Directory.CreateDirectory("Build");
                BuildReport report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
                {
                    scenes = new[] { ScenePath },
                    locationPathName = OutputPath,
                    target = BuildTarget.StandaloneOSX,
                    options = BuildOptions.Development
                });
                if (report.summary.result != BuildResult.Succeeded)
                {
                    throw new System.InvalidOperationException("Standalone dynamic assembly spike build failed: " + report.summary.result);
                }
            }
            finally
            {
                PlayerSettings.SetScriptingBackend(BuildTargetGroup.Standalone, previousBackend);
                PlayerSettings.SetManagedStrippingLevel(BuildTargetGroup.Standalone, previousStripping);
            }
        }

        private static string ComputeSha256(byte[] bytes)
        {
            using SHA256 hash = SHA256.Create();
            return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", string.Empty).ToLowerInvariant();
        }
    }
}
