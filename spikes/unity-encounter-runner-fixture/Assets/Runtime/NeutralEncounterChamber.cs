using System;
using System.Security.Cryptography;
using UnityEngine;

namespace MythMaker.NeutralEncounterRunner
{
    /// <summary>A disposable neutral chamber: two non-host actors exchange scripted damage.</summary>
    public sealed class NeutralEncounterChamber : MonoBehaviour
    {
        public int PlayerHitPoints { get; private set; } = 20;
        public int TargetHitPoints { get; private set; } = 20;
        public bool PlayerHitObserved { get; private set; }
        public bool TargetHitObserved { get; private set; }

        public DamageEvent[] RunScriptedExchange(NeutralEncounterAssemblyReceipt assembly)
        {
            if (assembly == null || !assembly.IsLoadable)
            {
                throw new System.InvalidOperationException("invalid_neutral_assembly_receipt");
            }
            TargetHitPoints -= 9;
            TargetHitObserved = true;
            Debug.Log("MYTH_MAKER_HIT actor=player target=encounter-target damage=9");
            PlayerHitPoints -= 4;
            PlayerHitObserved = true;
            Debug.Log("MYTH_MAKER_HIT actor=encounter-target target=player damage=4");
            return new[] { new DamageEvent(100, "player", "encounter-target", 9), new DamageEvent(250, "encounter-target", "player", 4) };
        }
    }

    public sealed class DamageEvent
    {
        public int AtMilliseconds { get; }
        public string Actor { get; }
        public string Target { get; }
        public int Damage { get; }
        public DamageEvent(int atMilliseconds, string actor, string target, int damage) { AtMilliseconds = atMilliseconds; Actor = actor; Target = target; Damage = damage; }
    }

    /// <summary>Smallest frozen package and selected revisions, loaded from an immutable receipt resource.</summary>
    public sealed class NeutralEncounterAssemblyReceipt
    {
        private readonly AssemblyDocument document;
        private const string ResourceSha256 = "4b74d845c16f95229c6a7503212e470e90794c9689aa0a5d7e90ccd4c041d914";
        private NeutralEncounterAssemblyReceipt(AssemblyDocument document) => this.document = document;
        public string AssemblyId => document.assembly_id;
        public string EncounterId => document.encounter_id;
        public string PackageManifestSha256 => document.package_manifest_sha256;
        public string AssemblySha256 => document.assembly_sha256;
        public string AssetSha256 => document.selected_assets[0].sha256;
        public string AnimationSha256 => document.selected_animations[0].sha256;
        public string AssetId => document.selected_assets[0].asset_id;
        public string AnimationId => document.selected_animations[0].animation_id;
        public int AssetRevision => document.selected_assets[0].revision;
        public int AnimationRevision => document.selected_animations[0].revision;
        public bool IsLoadable => document.schema_version == "1" && document.assembly_id == "neutral-chamber-assembly" && document.encounter_id == "neutral-chamber" && document.frozen_package != null && document.frozen_package.package_id == "neutral-chamber-package" && document.frozen_package.encounter_id == EncounterId && document.frozen_package.state == "frozen" && document.frozen_package.manifest_sha256 == PackageManifestSha256 && document.selected_assets?.Length == 1 && document.selected_animations?.Length == 1 && document.selected_assets[0].asset_id == "neutral-target" && document.selected_animations[0].animation_id == "neutral-strike" && !string.IsNullOrEmpty(document.selected_assets[0].uri) && !string.IsNullOrEmpty(document.selected_animations[0].uri) && Hash(PackageManifestSha256) && Hash(AssemblySha256) && Hash(AssetSha256) && Hash(AnimationSha256);

        public static NeutralEncounterAssemblyReceipt LoadFrozen()
        {
            TextAsset source = Resources.Load<TextAsset>("neutral-assembly-receipt");
            if (source == null || Sha256(source.bytes) != ResourceSha256) throw new InvalidOperationException("neutral_assembly_receipt_hash_mismatch");
            AssemblyDocument document = JsonUtility.FromJson<AssemblyDocument>(source.text);
            NeutralEncounterAssemblyReceipt receipt = document == null ? null : new(document);
            if (receipt == null || !receipt.IsLoadable) throw new System.InvalidOperationException("invalid_neutral_assembly_receipt");
            return receipt;
        }

        private static bool Hash(string value) => value != null && value.Length == 64;
        private static string Sha256(byte[] bytes) { using SHA256 sha = SHA256.Create(); return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", string.Empty).ToLowerInvariant(); }
        [Serializable] private sealed class AssemblyDocument { public string schema_version; public string assembly_id; public string encounter_id; public string package_manifest_sha256; public string assembly_sha256; public FrozenPackage frozen_package; public SelectedAsset[] selected_assets; public SelectedAnimation[] selected_animations; }
        [Serializable] private sealed class FrozenPackage { public string package_id; public string encounter_id; public string state; public string manifest_sha256; }
        [Serializable] private sealed class SelectedAsset { public string asset_id; public int revision; public string sha256; public string uri; }
        [Serializable] private sealed class SelectedAnimation { public string animation_id; public int revision; public string sha256; public string uri; }
    }
}
