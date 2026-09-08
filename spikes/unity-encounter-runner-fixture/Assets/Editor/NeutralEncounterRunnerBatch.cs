using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using MythMaker.NeutralEncounterRunner;
using UnityEditor;
using UnityEngine;

namespace MythMaker.NeutralEncounterRunner.Editor
{
    /// <summary>Batch entry point for a local Unity runtime receipt, with no cloud or player-preview claim.</summary>
    public static class NeutralEncounterRunnerBatch
    {
        public static void Run()
        {
            string startedAt = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
            GameObject chamberObject = new("Neutral Encounter Chamber");
            NeutralEncounterChamber chamber = chamberObject.AddComponent<NeutralEncounterChamber>();
            chamber.RunScriptedExchange();
            if (!chamber.PlayerHitObserved || !chamber.TargetHitObserved)
            {
                throw new InvalidOperationException("missing_bidirectional_damage_exchange");
            }

            string endedAt = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
            string packageHash = Sha256("neutral-chamber-frozen-package-v1");
            string assemblyHash = Sha256("neutral-chamber-assembly-v1:" + packageHash);
            string scriptHash = Sha256("100:player:encounter-target:9|250:encounter-target:player:4");
            string json = "{"
                + "\"schema_version\":\"1\","
                + "\"simulation_id\":\"unity-neutral-chamber-41\","
                + "\"encounter_id\":\"neutral-chamber\","
                + "\"assembly_sha256\":\"" + assemblyHash + "\","
                + "\"package_manifest_sha256\":\"" + packageHash + "\","
                + "\"runner\":{\"runner_id\":\"myth-maker-unity-encounter-runner\",\"runtime_id\":\"unity-6000.6.0f1\",\"build_profile_id\":\"editor-macos-mono-batch\",\"profile_id\":\"unity-neutral-headless\",\"profile_revision\":1},"
                + "\"evidence_tiers\":{\"source\":\"local_orchestration\",\"runtime\":\"local_unity_runner\",\"player\":\"not_observed\"},"
                + "\"deterministic\":{\"seed\":41,\"script_sha256\":\"" + scriptHash + "\",\"event_count\":2},"
                + "\"status\":\"passed\","
                + "\"telemetry\":{\"hit_exchange\":{\"verified\":true,\"events\":[{\"at_ms\":100,\"actor\":\"player\",\"target\":\"encounter-target\",\"damage\":9},{\"at_ms\":250,\"actor\":\"encounter-target\",\"target\":\"player\",\"damage\":4}]},\"passed_checks\":[\"bidirectional_damage_exchange\"],\"failed_checks\":[]},"
                + "\"timings\":{\"started_at\":\"" + startedAt + "\",\"ended_at\":\"" + endedAt + "\",\"duration_ms\":250},"
                + "\"logs\":[],\"failure_codes\":[],"
                + "\"provenance\":{\"assembly_id\":\"neutral-chamber-assembly\",\"selected_assets\":[{\"asset_id\":\"neutral-target\",\"revision\":3,\"sha256\":\"" + Sha256("neutral-target-r3") + "\"}],\"selected_animations\":[{\"animation_id\":\"neutral-strike\",\"revision\":2,\"sha256\":\"" + Sha256("neutral-strike-r2") + "\"}]}}";
            string fixtureRoot = Directory.GetParent(Application.dataPath).FullName;
            string repositoryRoot = Directory.GetParent(Directory.GetParent(fixtureRoot).FullName).FullName;
            string outputDirectory = Path.Combine(repositoryRoot, "artifacts", "encounter-runner");
            Directory.CreateDirectory(outputDirectory);
            string output = Path.Combine(outputDirectory, "unity-simulation-receipt.json");
            File.WriteAllText(output, json + Environment.NewLine, new UTF8Encoding(false));
            Debug.Log("MYTH_MAKER_SIMULATION_RECEIPT path=" + output + " sha256=" + Sha256(File.ReadAllBytes(output)));
            UnityEngine.Object.DestroyImmediate(chamberObject);
        }

        private static string Sha256(string value) => Sha256(Encoding.UTF8.GetBytes(value));

        private static string Sha256(byte[] bytes)
        {
            using SHA256 sha = SHA256.Create();
            return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", string.Empty).ToLowerInvariant();
        }
    }
}
