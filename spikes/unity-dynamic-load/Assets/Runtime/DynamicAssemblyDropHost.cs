using UnityEngine;

namespace MythMaker.DynamicAssemblySpike
{
    /// <summary>Drag a .bytes fixture into Plugin Assembly, or let this spike load the Resources fixture at startup.</summary>
    [DisallowMultipleComponent]
    public sealed class DynamicAssemblyDropHost : MonoBehaviour
    {
        [SerializeField, Tooltip("Drag a byte-backed DLL asset (.bytes) here; importing a raw DLL would make Unity treat it as a normal plugin.")]
        private TextAsset pluginAssembly;
        [SerializeField] private string expectedSha256;
        [SerializeField] private string entrypointType = "fixture.DynamicProbe";
        [SerializeField] private string entrypointMethod = "Describe";
        [SerializeField] private bool loadOnStart = true;

        public DynamicAssemblyReceipt LastReceipt { get; private set; }

        private void Start()
        {
            if (loadOnStart)
            {
                bool loaded = TryLoadConfiguredPlugin();
                if (Application.isBatchMode)
                {
                    Application.Quit(loaded ? 0 : 1);
                }
            }
        }

        public bool TryLoadConfiguredPlugin()
        {
            TextAsset selected = pluginAssembly != null ? pluginAssembly : Resources.Load<TextAsset>("DynamicPluginFixture");
            bool loaded = DynamicAssemblyLoader.TryLoad(selected == null ? null : selected.bytes, entrypointType, entrypointMethod, out DynamicAssemblyReceipt receipt, expectedSha256);
            LastReceipt = receipt;
            Debug.Log($"[DynamicAssemblySpike] status={receipt.Status}; sha256={receipt.Sha256}; entrypoint={receipt.Entrypoint}; message={receipt.Message}", this);
            return loaded;
        }

        private void OnGUI()
        {
            GUIStyle title = new GUIStyle(GUI.skin.label) { fontSize = 28, fontStyle = FontStyle.Bold, normal = { textColor = Color.white } };
            GUIStyle body = new GUIStyle(GUI.skin.label) { fontSize = 18, wordWrap = true, normal = { textColor = new Color(0.82f, 0.87f, 0.92f) } };
            GUIStyle status = new GUIStyle(body) { fontSize = 24, fontStyle = FontStyle.Bold, normal = { textColor = LastReceipt.Status == DynamicAssemblyLoadStatus.Loaded ? new Color(0.36f, 0.95f, 0.62f) : new Color(1f, 0.62f, 0.3f) } };

            GUI.Box(new Rect(36, 36, 920, 308), GUIContent.none);
            GUI.Label(new Rect(68, 68, 850, 40), "Dynamic Assembly Spike", title);
            GUI.Label(new Rect(68, 124, 850, 52), "Inspector workflow: drag a .bytes assembly into Plugin Assembly, then enter Play mode.", body);
            GUI.Label(new Rect(68, 194, 850, 34), "STATUS  " + LastReceipt.Status, status);
            GUI.Label(new Rect(68, 242, 850, 64), LastReceipt.Message ?? "Awaiting load.", body);
        }
    }
}
