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
            NeutralEncounterAssemblyReceipt assembly = NeutralEncounterAssemblyReceipt.LoadFrozen();
            DamageEvent[] events = chamber.RunScriptedExchange(assembly);
            bool verifiedExchange = chamber.PlayerHitObserved && chamber.TargetHitObserved && events.Length >= 2;
            if (!verifiedExchange)
            {
                throw new InvalidOperationException("missing_bidirectional_damage_exchange");
            }

            string endedAt = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
            string packageHash = assembly.PackageManifestSha256;
            string assemblyHash = assembly.AssemblySha256;
            string eventJson = EventsJson(events);
            string scriptHash = Sha256(eventJson);
            string status = verifiedExchange ? "passed" : "failed";
            string passedChecks = verifiedExchange ? "[\"bidirectional_damage_exchange\"]" : "[]";
            string failedChecks = verifiedExchange ? "[]" : "[\"bidirectional_damage_exchange\"]";
            string json = "{"
                + "\"schema_version\":\"1\","
                + "\"simulation_id\":\"unity-neutral-chamber-41\","
                + "\"encounter_id\":\"" + assembly.EncounterId + "\","
                + "\"assembly_sha256\":\"" + assemblyHash + "\","
                + "\"package_manifest_sha256\":\"" + packageHash + "\","
                + "\"runner\":{\"runner_id\":\"myth-maker-unity-encounter-runner\",\"runtime_id\":\"unity-6000.6.0f1\",\"build_profile_id\":\"editor-macos-mono-batch\",\"profile_id\":\"unity-neutral-headless\",\"profile_revision\":1},"
                + "\"evidence_tiers\":{\"source\":\"local_orchestration\",\"runtime\":\"local_unity_runner\",\"player\":\"not_observed\"},"
                + "\"deterministic\":{\"seed\":41,\"script_sha256\":\"" + scriptHash + "\",\"script\":" + eventJson + ",\"event_count\":" + events.Length + "},"
                + "\"status\":\"" + status + "\","
                + "\"telemetry\":{\"hit_exchange\":{\"verified\":" + verifiedExchange.ToString().ToLowerInvariant() + ",\"events\":" + eventJson + "},\"passed_checks\":" + passedChecks + ",\"failed_checks\":" + failedChecks + "},"
                + "\"timings\":{\"started_at\":\"" + startedAt + "\",\"ended_at\":\"" + endedAt + "\",\"duration_ms\":250},"
                + "\"logs\":[{\"path\":\"unity-batch.log\",\"sha256\":null}],\"failure_codes\":[],"
                + "\"provenance\":{\"assembly_id\":\"" + assembly.AssemblyId + "\",\"selected_assets\":[{\"asset_id\":\"" + assembly.AssetId + "\",\"revision\":" + assembly.AssetRevision + ",\"sha256\":\"" + assembly.AssetSha256 + "\"}],\"selected_animations\":[{\"animation_id\":\"" + assembly.AnimationId + "\",\"revision\":" + assembly.AnimationRevision + ",\"sha256\":\"" + assembly.AnimationSha256 + "\"}]}}";
            string fixtureRoot = Directory.GetParent(Application.dataPath).FullName;
            string repositoryRoot = Directory.GetParent(Directory.GetParent(fixtureRoot).FullName).FullName;
            string outputDirectory = Path.Combine(repositoryRoot, "artifacts", "encounter-runner");
            Directory.CreateDirectory(outputDirectory);
            string output = Path.Combine(outputDirectory, "unity-simulation-receipt.json");
            File.WriteAllText(output, json + Environment.NewLine, new UTF8Encoding(false));
            Debug.Log("MYTH_MAKER_ASSEMBLY_RECEIPT package=" + packageHash + " assembly=" + assemblyHash + " asset_revision=" + assembly.AssetRevision + " animation_revision=" + assembly.AnimationRevision);
            Debug.Log("MYTH_MAKER_SIMULATION_RECEIPT path=" + output + " sha256=" + Sha256(File.ReadAllBytes(output)));
            UnityEngine.Object.DestroyImmediate(chamberObject);
        }

        private static string Sha256(string value) => Sha256(Encoding.UTF8.GetBytes(value));

        private static string EventsJson(DamageEvent[] events)
        {
            StringBuilder json = new("[");
            for (int index = 0; index < events.Length; index += 1)
            {
                DamageEvent entry = events[index];
                if (index > 0) json.Append(',');
                json.Append("{\"actor\":\"").Append(entry.Actor).Append("\",\"at_ms\":").Append(entry.AtMilliseconds).Append(",\"damage\":").Append(entry.Damage).Append(",\"target\":\"").Append(entry.Target).Append("\"}");
            }
            return json.Append(']').ToString();
        }

        private static string Sha256(byte[] bytes)
        {
            using SHA256 sha = SHA256.Create();
            return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", string.Empty).ToLowerInvariant();
        }
    }
}
