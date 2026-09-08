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

        public void RunScriptedExchange(NeutralEncounterAssemblyReceipt assembly)
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
        }
    }

    /// <summary>Smallest frozen package and selected revisions, loaded from an immutable receipt resource.</summary>
    public sealed class NeutralEncounterAssemblyReceipt
    {
        private readonly AssemblyDocument document;
        private NeutralEncounterAssemblyReceipt(AssemblyDocument document) => this.document = document;
        public string EncounterId => document.encounter_id;
        public string PackageManifestSha256 => document.package_manifest_sha256;
        public string AssemblySha256 => document.assembly_sha256;
        public string AssetSha256 => document.selected_assets[0].sha256;
        public string AnimationSha256 => document.selected_animations[0].sha256;
        public int AssetRevision => document.selected_assets[0].revision;
        public int AnimationRevision => document.selected_animations[0].revision;
        public bool IsLoadable => document.schema_version == "1" && document.frozen_package != null && document.frozen_package.state == "frozen" && document.frozen_package.manifest_sha256 == PackageManifestSha256 && document.selected_assets?.Length == 1 && document.selected_animations?.Length == 1 && Hash(PackageManifestSha256) && Hash(AssemblySha256) && Hash(AssetSha256) && Hash(AnimationSha256);

        public static NeutralEncounterAssemblyReceipt LoadFrozen()
        {
            TextAsset source = Resources.Load<TextAsset>("neutral-assembly-receipt");
            AssemblyDocument document = source == null ? null : JsonUtility.FromJson<AssemblyDocument>(source.text);
            NeutralEncounterAssemblyReceipt receipt = document == null ? null : new(document);
            if (receipt == null || !receipt.IsLoadable) throw new System.InvalidOperationException("invalid_neutral_assembly_receipt");
            return receipt;
        }

        private static bool Hash(string value) => value != null && value.Length == 64;
        [System.Serializable] private sealed class AssemblyDocument { public string schema_version; public string encounter_id; public string package_manifest_sha256; public string assembly_sha256; public FrozenPackage frozen_package; public SelectedAsset[] selected_assets; public SelectedAnimation[] selected_animations; }
        [System.Serializable] private sealed class FrozenPackage { public string state; public string manifest_sha256; }
        [System.Serializable] private sealed class SelectedAsset { public int revision; public string sha256; }
        [System.Serializable] private sealed class SelectedAnimation { public int revision; public string sha256; }
    }
}
