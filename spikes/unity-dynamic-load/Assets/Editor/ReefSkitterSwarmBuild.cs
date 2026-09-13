using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace MythMaker.DynamicAssemblySpike.Editor
{
    public static class ReefSkitterSwarmBuild
    {
        private const string ScenePath = "Assets/ReefSkitterSwarmBenchmark.unity";
        private const string OutputPath = "Build/ReefSkitterSwarmBenchmark.app";

        [MenuItem("Myth Maker/Create Reef Skitter Swarm Benchmark")]
        public static void CreateScene()
        {
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            new GameObject("Reef Skitter Swarm Benchmark").AddComponent<ReefSkitterSwarmBenchmark>();
            EditorSceneManager.SaveScene(scene, ScenePath);
        }

        public static void BuildStandalone()
        {
            CreateScene(); Directory.CreateDirectory("Build"); bool previousFrameTiming = PlayerSettings.enableFrameTimingStats;
            try
            {
                PlayerSettings.enableFrameTimingStats = true;
                BuildReport report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
                {
                    scenes = new[] { ScenePath }, locationPathName = OutputPath,
                    target = BuildTarget.StandaloneOSX, options = BuildOptions.Development
                });
                if (report.summary.result != BuildResult.Succeeded) throw new System.InvalidOperationException("Reef Skitter swarm benchmark build failed: " + report.summary.result);
            }
            finally { PlayerSettings.enableFrameTimingStats = previousFrameTiming; }
        }
    }
}
